import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import type { StandbyStatus } from "@ag/shared";
import { eq } from "drizzle-orm";
import { TransferService } from "../competitions/transfer.service";
import { DB, type Db } from "../db/db.module";
import { competitions, settings } from "../db/schema";

const SETTING = "standby";
/** Как часто запасной ноутбук забирает турниры с основного. */
export const STANDBY_INTERVAL_MS = 15_000;

interface StandbyConfig {
  primaryUrl: string;
  token: string;
}

interface CopiedTournament {
  id: string;
  name: string;
  file: unknown;
  copiedAt: string;
}

/**
 * Запасной ноутбук в горячем резерве. Каждые 15 секунд он забирает с основного ноутбука
 * все турниры целиком (тем же файлом, что «Выгрузить в файл») и держит их у себя.
 * Если основной сломался, секретарь нажимает «Продолжить на этом ноутбуке»: турниры
 * загружаются с теми же id и QR-кодами, а планшеты сами находят новый адрес.
 */
@Injectable()
export class StandbyService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("Standby");
  private timer: NodeJS.Timeout | null = null;
  private config: StandbyConfig | null = null;
  private copies = new Map<string, CopiedTournament>();
  private lastSyncAt: string | null = null;
  private lastError: string | null = null;
  private running = false;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly transfer: TransferService,
  ) {}

  async onModuleInit(): Promise<void> {
    const [row] = await this.db.select().from(settings).where(eq(settings.key, SETTING));
    if (row) {
      try {
        this.config = JSON.parse(row.value) as StandbyConfig;
      } catch {
        this.config = null;
      }
    }
    this.timer = setInterval(() => void this.sync(), STANDBY_INTERVAL_MS);
    this.timer.unref();
    if (this.config) void this.sync();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  status(): StandbyStatus {
    return {
      enabled: this.config !== null,
      primaryUrl: this.config?.primaryUrl ?? null,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
      tournaments: [...this.copies.values()].map((c) => ({ id: c.id, name: c.name, copiedAt: c.copiedAt })),
    };
  }

  /** Включает резерв: проверяет, что основной ноутбук отвечает и токен подходит, и сразу забирает турниры. */
  async configure(primaryUrl: string, token: string): Promise<StandbyStatus> {
    const url = primaryUrl.trim().replace(/\/+$/, "").replace(/\/judge.*$/, "");
    const next = { primaryUrl: url, token: token.trim() };
    await this.fetchList(next);
    await this.save(next);
    this.copies.clear();
    await this.sync();
    return this.status();
  }

  async disable(): Promise<StandbyStatus> {
    await this.save(null);
    this.copies.clear();
    this.lastSyncAt = null;
    this.lastError = null;
    return this.status();
  }

  /** Забирает все турниры с основного ноутбука. Ошибка связи не стирает уже забранные копии. */
  async sync(): Promise<void> {
    const config = this.config;
    if (!config || this.running) return;
    this.running = true;
    try {
      const list = await this.fetchList(config);
      const fresh = new Map<string, CopiedTournament>();
      for (const c of list) {
        const response = await fetch(`${config.primaryUrl}/competitions/${c.id}/export`, {
          headers: { Authorization: `Bearer ${config.token}` },
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) throw new Error(`турнир «${c.name}»: ответ ${response.status}`);
        fresh.set(c.id, { id: c.id, name: c.name, file: await response.json(), copiedAt: new Date().toISOString() });
      }
      if (this.config === config) {
        this.copies = fresh;
        this.lastSyncAt = new Date().toISOString();
        this.lastError = null;
      }
    } catch (e) {
      this.lastError = describe(e);
    } finally {
      this.running = false;
    }
  }

  /**
   * Основной ноутбук сломался: загружаем последние копии турниров на этот ноутбук.
   * Турнир, который уже есть здесь (например, после прошлой подмены), заменяется копией.
   * После этого резерв выключается: этот ноутбук становится основным.
   */
  async takeOver(): Promise<{ loaded: { id: string; name: string }[]; copiedAt: string | null }> {
    const copies = [...this.copies.values()];
    if (copies.length === 0) throw new Error("Копий турниров ещё нет: запасной ноутбук не успел их забрать");
    const copiedAt = this.lastSyncAt;
    const loaded: { id: string; name: string }[] = [];
    for (const copy of copies) {
      const [existing] = await this.db.select({ id: competitions.id }).from(competitions).where(eq(competitions.id, copy.id));
      if (existing) await this.transfer.remove(copy.id);
      loaded.push(await this.transfer.import(copy.file));
    }
    await this.save(null);
    this.copies.clear();
    this.log.log(`работа продолжена на запасном ноутбуке: ${loaded.map((l) => l.name).join(", ")}`);
    return { loaded, copiedAt };
  }

  private async fetchList(config: StandbyConfig): Promise<{ id: string; name: string }[]> {
    let response: Response;
    try {
      response = await fetch(`${config.primaryUrl}/competitions`, {
        headers: { Authorization: `Bearer ${config.token}` },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      throw new Error(`основной ноутбук не отвечает по адресу ${config.primaryUrl}: ${describe(e)}`);
    }
    if (!response.ok) throw new Error(`основной ноутбук ответил ${response.status}`);
    const list = (await response.json()) as { id: string; name: string }[];
    // Токен проверяем сразу: без него турниры не выгрузить.
    const check = list[0]
      ? await fetch(`${config.primaryUrl}/competitions/${list[0].id}/export`, {
          method: "HEAD",
          headers: { Authorization: `Bearer ${config.token}` },
          signal: AbortSignal.timeout(10_000),
        })
      : null;
    if (check && (check.status === 401 || check.status === 403)) throw new Error("токен секретариата основного ноутбука не подходит");
    return list;
  }

  private async save(config: StandbyConfig | null): Promise<void> {
    this.config = config;
    if (config) {
      const value = JSON.stringify(config);
      await this.db.insert(settings).values({ key: SETTING, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
    } else {
      await this.db.delete(settings).where(eq(settings.key, SETTING));
    }
  }
}

function describe(e: unknown): string {
  const err = e as Error & { cause?: { code?: string } };
  return err.cause?.code ? `${err.message} (${err.cause.code})` : err.message;
}
