import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OnlineEntry, OnlineEntryCall, ReceivedOnlineEntry } from "@ag/shared";

/** Больше заявок на одно соревнование не принимаем: защита от засорения. */
export const MAX_ENTRIES = 500;

interface Saved {
  id: string;
  call: OnlineEntryCall;
  key: string;
  entries: ReceivedOnlineEntry[];
}

/**
 * Онлайн-заявки клубов. Зал публикует приём (название, разряды, срок)
 * и секретный ключ ссылки; клубы присылают заявки, зал забирает их.
 * Всё хранится в памяти и в файле на соревнование.
 */
export class EntryStore {
  private readonly items = new Map<string, Saved>();
  private readonly writes = new Map<string, Promise<void>>();
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, "entries");
  }

  async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    for (const name of await readdir(this.dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const saved = JSON.parse(await readFile(join(this.dir, name), "utf8")) as Saved;
        this.items.set(saved.id, saved);
      } catch {
        // Повреждённый файл пропускаем: зал опубликует приём заново.
      }
    }
  }

  async publish(id: string, call: OnlineEntryCall, key: string): Promise<void> {
    const current = this.items.get(id);
    await this.save({ id, call, key, entries: current?.entries ?? [] });
  }

  /** Приём по ссылке: только с верным ключом. */
  call(id: string, key: string): OnlineEntryCall | undefined {
    const saved = this.items.get(id);
    if (!saved) return undefined;
    const given = Buffer.from(key);
    const expected = Buffer.from(saved.key);
    return given.length === expected.length && timingSafeEqual(given, expected) ? saved.call : undefined;
  }

  entries(id: string): ReceivedOnlineEntry[] {
    return this.items.get(id)?.entries ?? [];
  }

  async add(id: string, entry: OnlineEntry): Promise<ReceivedOnlineEntry> {
    const saved = this.items.get(id)!;
    const received: ReceivedOnlineEntry = { ...entry, id: randomUUID(), receivedAt: new Date().toISOString() };
    await this.save({ ...saved, entries: [...saved.entries, received] });
    return received;
  }

  private async save(saved: Saved): Promise<void> {
    this.items.set(saved.id, saved);
    const file = join(this.dir, `${saved.id}.json`);
    const write = (this.writes.get(saved.id) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        await writeFile(`${file}.tmp`, JSON.stringify(this.items.get(saved.id)));
        await rename(`${file}.tmp`, file);
      });
    this.writes.set(saved.id, write);
    await write;
  }
}
