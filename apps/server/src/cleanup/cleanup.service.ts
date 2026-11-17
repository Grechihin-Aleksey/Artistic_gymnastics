import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { CLEANUP_DEFAULT_DAYS, CLEANUP_KEEP_DUMPS, type CleanupStatus } from "@ag/shared";
import { eq } from "drizzle-orm";
import { APP_CONFIG, type AppConfig } from "../config";
import { DB, type Db } from "../db/db.module";
import { settings } from "../db/schema";

const SETTING = "cleanup.days";
const DUMP = /^gymnastics-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.dump$/;
/** Проверка раз в 6 часов: точность до дня не нужна. */
const CLEANUP_INTERVAL_MS = 6 * 3600_000;
const DAY_MS = 24 * 3600_000;

interface Dump {
  name: string;
  /** Время снятия из имени файла, оно же время изменения базы (копия без изменений не снимается). */
  takenAt: number;
  bytes: number;
}

/**
 * Очистка после турниров. Во время турнира копия базы снимается каждые 5 минут
 * и за сутки набирается 288 файлов. Когда турнир закончился, база не меняется и
 * новые копии не снимаются (scripts/backup-loop.sh), но старые остаются лежать.
 * Через заданное число дней без изменений лишние копии удаляются: самые свежие
 * CLEANUP_KEEP_DUMPS остаются всегда, в них все турниры целиком. Турниры,
 * протоколы, результаты и файлы турниров (backups/tournaments) не трогаются.
 */
@Injectable()
export class CleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("Cleanup");
  private timer: NodeJS.Timeout | null = null;
  private lastRun: CleanupStatus["lastRun"] = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    if (!this.config.backupDir) return;
    this.timer = setInterval(() => void this.auto(), CLEANUP_INTERVAL_MS);
    this.timer.unref();
    setTimeout(() => void this.auto(), 60_000).unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async days(): Promise<number> {
    const [row] = await this.db.select().from(settings).where(eq(settings.key, SETTING));
    const value = row ? Number(row.value) : CLEANUP_DEFAULT_DAYS;
    return Number.isInteger(value) && value >= 0 ? value : CLEANUP_DEFAULT_DAYS;
  }

  async setDays(days: number): Promise<CleanupStatus> {
    const value = String(days);
    await this.db.insert(settings).values({ key: SETTING, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
    return this.status();
  }

  async status(now = Date.now()): Promise<CleanupStatus> {
    const days = await this.days();
    const dumps = await this.dumps();
    const removable = dumps.slice(CLEANUP_KEEP_DUMPS);
    const lastChange = dumps[0]?.takenAt ?? null;
    return {
      enabled: Boolean(this.config.backupDir),
      days,
      lastChangeAt: lastChange === null ? null : new Date(lastChange).toISOString(),
      dueAt: days > 0 && lastChange !== null && removable.length > 0 ? new Date(Math.max(now, lastChange + days * DAY_MS)).toISOString() : null,
      dumps: { count: dumps.length, bytes: sum(dumps) },
      removable: { count: removable.length, bytes: sum(removable) },
      lastRun: this.lastRun,
    };
  }

  /** Автоматически: только если база не менялась заданное число дней. */
  async auto(now = Date.now()): Promise<CleanupStatus> {
    try {
      const days = await this.days();
      const dumps = await this.dumps();
      if (days > 0 && dumps.length > CLEANUP_KEEP_DUMPS && now - dumps[0]!.takenAt >= days * DAY_MS) {
        await this.remove(dumps.slice(CLEANUP_KEEP_DUMPS), true);
      }
    } catch (e) {
      this.log.warn(`Очистка не удалась: ${(e as Error).message}`);
    }
    return this.status(now);
  }

  /** По кнопке «Очистить сейчас»: сразу, свежие копии остаются. */
  async runNow(): Promise<CleanupStatus> {
    await this.remove((await this.dumps()).slice(CLEANUP_KEEP_DUMPS), false);
    return this.status();
  }

  private async remove(list: Dump[], auto: boolean): Promise<void> {
    const dir = this.config.backupDir!;
    let deleted = 0;
    let freedBytes = 0;
    for (const d of list) {
      try {
        await unlink(join(dir, d.name));
        deleted++;
        freedBytes += d.bytes;
      } catch {
        // Файл уже удалил контейнер backup по своему счёту: не страшно.
      }
    }
    this.lastRun = { at: new Date().toISOString(), deleted, freedBytes, auto };
    if (deleted > 0) this.log.log(`Удалено старых копий базы: ${deleted}, освобождено ${Math.round(freedBytes / 1024 ** 2)} МБ`);
  }

  /** Копии базы, самая свежая первой. */
  private async dumps(): Promise<Dump[]> {
    const dir = this.config.backupDir;
    if (!dir) return [];
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const list: Dump[] = [];
    for (const name of names) {
      const m = DUMP.exec(name);
      if (!m) continue;
      const [, y, mo, d, h, mi, s] = m.map(Number) as number[];
      const bytes = await stat(join(dir, name)).then((st) => st.size, () => null);
      // Время в имени — местное время контейнера backup (TZ тот же, что у сервера).
      if (bytes !== null) list.push({ name, takenAt: new Date(y!, mo! - 1, d!, h!, mi!, s!).getTime(), bytes });
    }
    return list.sort((a, b) => b.name.localeCompare(a.name));
  }
}

const sum = (list: Dump[]) => list.reduce((n, d) => n + d.bytes, 0);
