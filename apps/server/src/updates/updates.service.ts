import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import type { UpdateStatus } from "@ag/shared";
import { APP_CONFIG, type AppConfig } from "../config";

/** Первая проверка — через минуту после запуска, дальше раз в 6 часов. */
const FIRST_CHECK_MS = 60_000;
const CHECK_INTERVAL_MS = 6 * 3600_000;
const TIMEOUT_MS = 10_000;

interface VersionFile {
  version: string;
  notes: string[];
}

/** Версии вида 2026.11.16 сравниваются по числам: 2026.11.16 < 2026.11.20 < 2026.12.1. */
export function newerVersion(latest: string, current: string): boolean {
  const a = latest.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const b = current.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

export function parseVersionFile(raw: unknown): VersionFile | null {
  if (!raw || typeof raw !== "object") return null;
  const { version, notes } = raw as { version?: unknown; notes?: unknown };
  if (typeof version !== "string" || !/^\d+(\.\d+)*$/.test(version)) return null;
  const list = Array.isArray(notes) ? notes.filter((n): n is string => typeof n === "string").slice(0, 20) : [];
  return { version, notes: list.map((n) => n.slice(0, 200)) };
}

/** Своя версия: version.json кладётся рядом со сборкой сервера (в Docker — /app), в разработке — в корне репозитория. */
function readOwnVersion(file?: string): string {
  const candidates = file ? [file] : [join(__dirname, "..", "..", "version.json"), join(__dirname, "..", "..", "..", "..", "version.json")];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const parsed = parseVersionFile(JSON.parse(readFileSync(path, "utf8")));
      if (parsed) return parsed.version;
    } catch {
      // Битый файл — как будто версии нет.
    }
  }
  return "0";
}

/**
 * Узнаёт, вышла ли новая версия программы, чтобы секретариат обновился между турнирами,
 * а не узнал об исправлениях после. Сам ничего не скачивает и не ставит: обновляет «Обновить.bat».
 * Без интернета в зале проверка молча не удаётся, работе это не мешает.
 */
@Injectable()
export class UpdatesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UpdatesService.name);
  private readonly current: string;
  private latest: VersionFile | null = null;
  private checkedAt: Date | null = null;
  private timers: NodeJS.Timeout[] = [];

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.current = readOwnVersion(config.versionFile);
  }

  onModuleInit() {
    if (!this.config.updateUrl) return;
    const first = setTimeout(() => void this.check(), FIRST_CHECK_MS);
    const every = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    first.unref();
    every.unref();
    this.timers = [first, every];
  }

  onModuleDestroy() {
    for (const t of this.timers) clearTimeout(t);
  }

  status(): UpdateStatus {
    const latest = this.latest;
    return {
      current: this.current,
      latest: latest?.version ?? null,
      notes: latest && newerVersion(latest.version, this.current) ? latest.notes : [],
      available: Boolean(latest && newerVersion(latest.version, this.current)),
      checkedAt: this.checkedAt?.toISOString() ?? null,
    };
  }

  async check(): Promise<UpdateStatus> {
    const url = this.config.updateUrl;
    if (!url) return this.status();
    try {
      const headers: Record<string, string> = { "User-Agent": "gymnastics-update-check", Accept: "application/vnd.github.raw+json" };
      if (this.config.githubToken) headers.Authorization = `Bearer ${this.config.githubToken}`;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`ответ ${res.status}`);
      const parsed = parseVersionFile(await res.json());
      if (!parsed) throw new Error("непонятный файл версии");
      this.latest = parsed;
      this.checkedAt = new Date();
    } catch (e) {
      this.logger.debug(`Проверить новую версию не удалось: ${(e as Error).message}`);
    }
    return this.status();
  }
}
