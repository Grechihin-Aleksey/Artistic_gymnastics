import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProtocolsIndex, RelayProtocols } from "@ag/shared";

/** Имя файла протокола: латиница, цифры, точка, дефис — его подставляют в адрес. */
export const PROTOCOL_FILE = /^[a-z0-9][a-z0-9.-]{0,120}\.(pdf|xlsx)$/;

/**
 * Протоколы, которые зал выложил на сайт. Каждая публикация заменяет
 * предыдущую целиком: файлы пишутся в новую папку, затем она подменяет старую.
 */
export class ProtocolStore {
  private readonly dir: string;
  private readonly indexes = new Map<string, ProtocolsIndex>();

  constructor(dataDir: string) {
    this.dir = join(dataDir, "protocols");
  }

  async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    for (const id of await readdir(this.dir)) {
      if (id.endsWith(".tmp") || id.endsWith(".old")) {
        await rm(join(this.dir, id), { recursive: true, force: true });
        continue;
      }
      try {
        this.indexes.set(id, JSON.parse(await readFile(join(this.dir, id, "index.json"), "utf8")) as ProtocolsIndex);
      } catch {
        // Недописанная публикация: зал выложит протоколы заново.
      }
    }
  }

  index(id: string): ProtocolsIndex | undefined {
    return this.indexes.get(id);
  }

  async read(id: string, file: string): Promise<Buffer | undefined> {
    if (!this.indexes.get(id)?.files.some((f) => f.file === file)) return undefined;
    return readFile(join(this.dir, id, file));
  }

  async publish(id: string, body: RelayProtocols): Promise<ProtocolsIndex> {
    const target = join(this.dir, id);
    const tmp = `${target}.tmp`;
    await rm(tmp, { recursive: true, force: true });
    await mkdir(tmp, { recursive: true });
    const index: ProtocolsIndex = { publishedAt: new Date().toISOString(), files: [] };
    for (const f of body.files) {
      const data = Buffer.from(f.data, "base64");
      await writeFile(join(tmp, f.file), data);
      index.files.push({ file: f.file, title: f.title, group: f.group, size: data.length });
    }
    await writeFile(join(tmp, "index.json"), JSON.stringify(index));
    await rm(`${target}.old`, { recursive: true, force: true });
    await rename(target, `${target}.old`).catch(() => undefined);
    await rename(tmp, target);
    await rm(`${target}.old`, { recursive: true, force: true });
    this.indexes.set(id, index);
    return index;
  }

  async remove(id: string): Promise<void> {
    this.indexes.delete(id);
    await rm(join(this.dir, id), { recursive: true, force: true });
  }
}
