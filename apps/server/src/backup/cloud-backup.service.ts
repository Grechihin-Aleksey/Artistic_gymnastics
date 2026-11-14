import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config";
import { putObject } from "./s3";

export interface CloudBackupStatus {
  /** Хранилище настроено (S3_ENDPOINT, S3_BUCKET и ключи в .env). */
  enabled: boolean;
  bucket: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  /** Что ушло в хранилище при последней удачной отправке. */
  uploaded: string[];
}

/**
 * Копия базы и файлов турниров в облачное хранилище S3. Резервные копии в папке
 * backups лежат на том же ноутбуке: если он сломается или потеряется, пропадут и
 * они. Раз в S3_INTERVAL секунд свежая копия базы уходит в хранилище дважды:
 * как db/latest.dump и как копия дня db/daily/ГГГГ-ММ-ДД.dump. Дневная
 * перезаписывается в течение дня, поэтому хранилище не разрастается: один файл
 * на день. Файлы турниров (их можно загрузить кнопкой «Загрузить турнир из
 * файла») уходят в tournaments/, только если изменились.
 */
@Injectable()
export class CloudBackupService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("CloudBackup");
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** Что уже лежит в хранилище: имя файла → время изменения. */
  private readonly sent = new Map<string, number>();
  private state: Omit<CloudBackupStatus, "enabled" | "bucket"> = {
    lastSuccessAt: null,
    lastError: null,
    lastErrorAt: null,
    uploaded: [],
  };

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  onModuleInit(): void {
    if (!this.config.s3) return;
    const ms = Math.max(60, this.config.s3.interval) * 1000;
    // Первая отправка через минуту после запуска: база и первая копия успеют появиться.
    const first = setTimeout(() => void this.run(), 60_000);
    first.unref();
    this.timer = setInterval(() => void this.run(), ms);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  status(): CloudBackupStatus {
    return { enabled: Boolean(this.config.s3), bucket: this.config.s3?.bucket ?? null, ...this.state };
  }

  /** Отправляет то, что изменилось с прошлого раза; возвращает ключи отправленных файлов. */
  async run(now: Date = new Date()): Promise<string[]> {
    const s3 = this.config.s3;
    if (!s3 || this.running) return [];
    this.running = true;
    const uploaded: string[] = [];
    try {
      const prefix = s3.prefix ? `${s3.prefix.replace(/\/+$/, "")}/` : "";
      const dump = await newest(s3.backupDir, /^gymnastics-.*\.dump$/);
      if (dump && this.sent.get(dump.path) !== dump.mtime) {
        const body = await readFile(dump.path);
        const day = localDay(now);
        for (const key of [`${prefix}db/latest.dump`, `${prefix}db/daily/${day}.dump`]) {
          await putObject(s3, key, body);
          uploaded.push(key);
        }
        this.sent.set(dump.path, dump.mtime);
      }
      if (this.config.exportDir) {
        for (const file of await files(this.config.exportDir, /\.json$/)) {
          if (this.sent.get(file.path) === file.mtime) continue;
          const key = `${prefix}tournaments/${file.name}`;
          await putObject(s3, key, await readFile(file.path), "application/json");
          this.sent.set(file.path, file.mtime);
          uploaded.push(key);
        }
      }
      this.state = { ...this.state, lastSuccessAt: now.toISOString(), lastError: null, uploaded };
      if (uploaded.length > 0) this.log.log(`в облако: ${uploaded.join(", ")}`);
    } catch (e) {
      const message = (e as Error).message;
      this.state = { ...this.state, lastError: message, lastErrorAt: now.toISOString() };
      this.log.error(`не удалось отправить копию в облако: ${message}`);
    } finally {
      this.running = false;
    }
    return uploaded;
  }
}

interface FileInfo {
  name: string;
  path: string;
  mtime: number;
}

async function files(dir: string, pattern: RegExp): Promise<FileInfo[]> {
  const names = await readdir(dir).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return [] as string[];
    throw e;
  });
  const out: FileInfo[] = [];
  for (const name of names.filter((n) => pattern.test(n))) {
    const path = join(dir, name);
    const info = await stat(path);
    if (info.isFile()) out.push({ name, path, mtime: info.mtimeMs });
  }
  return out;
}

async function newest(dir: string, pattern: RegExp): Promise<FileInfo | undefined> {
  return (await files(dir, pattern)).sort((a, b) => b.mtime - a.mtime)[0];
}

/** Дата по часовому поясу сервера (TZ в .env), чтобы копия дня соответствовала дню турнира. */
function localDay(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
