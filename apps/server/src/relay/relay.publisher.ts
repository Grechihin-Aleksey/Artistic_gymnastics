import { Inject, Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import type { PerformanceView, RelayIngest } from "@ag/shared";
import { APP_CONFIG, type AppConfig } from "../config";
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
          this.known.add(competitionId);
          if (this.failures > 0) this.log.log("Связь с ретранслятором восстановлена");
          this.failures = 0;
        } catch (e) {
          // Пока отправляли, могли прийти новые оценки — сохраняем и их, и неотправленные.
          const fresh = this.pending.get(competitionId);
          this.pending.set(competitionId, {
            approved: [...entry.approved, ...(fresh?.approved ?? [])],
          });
          if (this.failures === 0) this.log.warn(`Не удалось отправить результаты на сайт: ${(e as Error).message}`);
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

  private async send(competitionId: string, entry: Pending): Promise<void> {
    const cutoff = Date.now() - FLASH_TTL_MS;
    const body: RelayIngest = {
      snapshot: await this.results.snapshot(competitionId),
      approved: entry.approved.filter((a) => a.at >= cutoff).map((a) => a.view),
    };
    const url = new URL(`ingest/${competitionId}`, this.config.relayUrl!.replace(/\/?$/, "/"));
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.config.relayToken}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`ретранслятор ответил ${response.status}`);
  }
}
