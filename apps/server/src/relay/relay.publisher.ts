import { Inject, Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import type { PerformanceView, RelayIngest } from "@ag/shared";
import { APP_CONFIG, relayHeaders, type AppConfig } from "../config";
import { ResultsService } from "../results/results.service";

/** Пачка событий подряд (вызов, утверждение) уходит одной отправкой. */
const DEBOUNCE_MS = 500;
const MAX_RETRY_MS = 60_000;
/** Раз в 5 минут повторяем все снимки на случай, если ретранслятор потерял данные. */
const RESYNC_MS = 5 * 60_000;
/** Старые оценки после обрыва связи на сайте уже не всплывают. */
const FLASH_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

interface Pending {
  approved: { view: PerformanceView; at: number }[];
}

/** Состояние связи с сайтом для секретариата. */
export interface RelayStatus {
  enabled: boolean;
  /** Когда снимок последний раз дошёл до сайта (ISO), null — ещё не отправляли. */
  sentAt: string | null;
  /** Почему последняя отправка не удалась; null — связь в порядке. */
  error: string | null;
}

/**
 * Отправляет снимки результатов в облачный ретранслятор, если задан RELAY_URL.
 * Связь из зала бывает плохой, поэтому неотправленное копится и уходит
 * при следующей удачной попытке; в очереди всегда только последний снимок.
 */
@Injectable()
export class RelayPublisher implements OnModuleDestroy {
  private readonly log = new Logger("Relay");
  private readonly pending = new Map<string, Pending>();
  private readonly known = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private resync: NodeJS.Timeout | null = null;
  private flushing = false;
  private failures = 0;
  private readonly sent = new Map<string, number>();
  private lastSentAt: number | null = null;
  private lastError: string | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly results: ResultsService,
  ) {
    if (this.enabled) {
      this.resync = setInterval(() => {
        for (const id of this.known) this.entry(id);
        this.schedule(0);
      }, RESYNC_MS);
      this.resync.unref();
    }
  }

  get enabled(): boolean {
    return Boolean(this.config.relayUrl && this.config.relayToken);
  }

  /** Результаты соревнования изменились; approved — только что утверждённая оценка. */
  notify(competitionId: string, approved?: PerformanceView): void {
    if (!this.enabled) return;
    const entry = this.entry(competitionId);
    if (approved) entry.approved.push({ view: approved, at: Date.now() });
    if (this.failures === 0) this.schedule(DEBOUNCE_MS);
  }

  /** Соревнование удалено: больше не отправлять и не пересылать его на сайт. */
  forget(competitionId: string): void {
    this.pending.delete(competitionId);
    this.known.delete(competitionId);
    this.sent.delete(competitionId);
  }

  /** Связь с сайтом в целом или по одному соревнованию. */
  status(competitionId?: string): RelayStatus {
    const at = competitionId ? this.sent.get(competitionId) : this.lastSentAt;
    return {
      enabled: this.enabled,
      sentAt: at ? new Date(at).toISOString() : null,
      error: this.enabled ? this.lastError : null,
    };
  }

  /** Отправить соревнование на сайт сейчас, не дожидаясь первой оценки; ошибка уходит вызывающему. */
  async publishNow(competitionId: string): Promise<RelayStatus> {
    if (!this.enabled) return this.status(competitionId);
    const entry = this.pending.get(competitionId) ?? { approved: [] };
    this.pending.delete(competitionId);
    try {
      await this.send(competitionId, entry);
      this.delivered(competitionId);
    } catch (e) {
      this.pending.set(competitionId, entry);
      this.lastError = (e as Error).message;
      this.schedule(DEBOUNCE_MS);
      throw e;
    }
    return this.status(competitionId);
  }

  onModuleDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.resync) clearInterval(this.resync);
  }

  private entry(competitionId: string): Pending {
    let entry = this.pending.get(competitionId);
    if (!entry) {
      entry = { approved: [] };
      this.pending.set(competitionId, entry);
    }
    return entry;
  }

  private schedule(delay: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), delay);
    this.timer.unref();
  }

  private async flush(): Promise<void> {
    this.timer = null;
    if (this.flushing) return this.schedule(DEBOUNCE_MS);
    this.flushing = true;
    try {
      for (const [competitionId, entry] of [...this.pending]) {
        this.pending.delete(competitionId);
        try {
          await this.send(competitionId, entry);
          this.delivered(competitionId);
          if (this.failures > 0) this.log.log("Связь с ретранслятором восстановлена");
          this.failures = 0;
        } catch (e) {
          // Пока отправляли, могли прийти новые оценки — сохраняем и их, и неотправленные.
          const fresh = this.pending.get(competitionId);
          this.pending.set(competitionId, {
            approved: [...entry.approved, ...(fresh?.approved ?? [])],
          });
          this.lastError = (e as Error).message;
          if (this.failures === 0) this.log.warn(`Не удалось отправить результаты на сайт: ${this.lastError}`);
          this.failures++;
        }
      }
    } finally {
      this.flushing = false;
    }
    if (this.pending.size > 0) {
      this.schedule(this.failures > 0 ? Math.min(MAX_RETRY_MS, 1000 * 2 ** (this.failures - 1)) : DEBOUNCE_MS);
    }
  }

  private delivered(competitionId: string): void {
    const now = Date.now();
    this.known.add(competitionId);
    this.sent.set(competitionId, now);
    this.lastSentAt = now;
    this.lastError = null;
  }

  private async send(competitionId: string, entry: Pending): Promise<void> {
    const cutoff = Date.now() - FLASH_TTL_MS;
    const body: RelayIngest = {
      snapshot: await this.results.snapshot(competitionId),
      approved: entry.approved.filter((a) => a.at >= cutoff).map((a) => a.view),
    };
    const url = new URL(`ingest/${competitionId}`, this.config.relayUrl!.replace(/\/?$/, "/"));
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: relayHeaders(this.config),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new Error("нет связи с сайтом: проверьте интернет и адрес RELAY_URL");
    }
    if (!response.ok) throw new Error(relayRefusal(response.status));
  }
}

/** Понятная секретарю причина отказа ретранслятора. */
function relayRefusal(status: number): string {
  if (status === 401) return "сайт не принял токен: RELAY_TOKEN в .env не совпадает с токеном в config.php";
  if (status === 503) return "на сайте не вписан токен в config.php";
  if (status === 404) return "по адресу RELAY_URL нет ретранслятора: проверьте адрес";
  return `сайт ответил ошибкой ${status}`;
}
