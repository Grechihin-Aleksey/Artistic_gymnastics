import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config";
import { DB, type Db } from "../db/db.module";
import { competitions } from "../db/schema";
import { TransferService } from "./transfer.service";

/**
 * Раз в EXPORT_INTERVAL секунд сохраняет каждый турнир файлом в EXPORT_DIR —
 * тем же, что даёт кнопка «Выгрузить в файл». Загрузить его можно кнопкой
 * «Загрузить турнир из файла», без командной строки. Файл турнира один и
 * перезаписывается, только если в турнире что-то изменилось.
 */
@Injectable()
export class AutoExportService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("AutoExport");
  private timer: NodeJS.Timeout | null = null;
  /** Отпечаток последней записанной выгрузки каждого турнира. */
  private readonly written = new Map<string, string>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DB) private readonly db: Db,
    private readonly transfer: TransferService,
  ) {}

  onModuleInit(): void {
    if (!this.config.exportDir) return;
    const ms = Math.max(60, this.config.exportInterval ?? 1800) * 1000;
    this.timer = setInterval(() => void this.run(), ms);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Выгружает изменившиеся турниры; возвращает имена записанных файлов. */
  async run(): Promise<string[]> {
    const dir = this.config.exportDir;
    if (!dir) return [];
    const saved: string[] = [];
    try {
      await mkdir(dir, { recursive: true });
      const list = await this.db.select({ id: competitions.id, name: competitions.name }).from(competitions);
      for (const c of list) {
        const file = await this.transfer.export(c.id);
        const hash = createHash("sha256").update(JSON.stringify(file.data)).digest("hex");
        if (this.written.get(c.id) === hash) continue;
        const name = exportFileName(c.name, c.id);
        // Пишем во временный файл и переименовываем: в папке не бывает оборванных выгрузок.
        await writeFile(join(dir, `${name}.part`), JSON.stringify(file));
        await rename(join(dir, `${name}.part`), join(dir, name));
        this.written.set(c.id, hash);
        saved.push(name);
      }
      if (saved.length > 0) this.log.log(`турниры выгружены: ${saved.join(", ")}`);
    } catch (e) {
      this.log.error(`не удалось выгрузить турниры: ${(e as Error).message}`);
    }
    return saved;
  }
}

/** Имя файла турнира: название без запрещённых в Windows знаков и начало id, чтобы одноимённые не путались. */
export function exportFileName(name: string, id: string): string {
  const safe = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim().slice(0, 80) || "турнир";
  return `${safe} (${id.slice(0, 8)}).json`;
}
