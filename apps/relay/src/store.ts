import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BoardSnapshot } from "@ag/shared";

export interface CompetitionSummary {
  id: string;
  name: string;
  discipline: string;
  updatedAt: string;
}

/**
 * Последний снимок каждого соревнования. Держится в памяти и дублируется
 * в файл, чтобы после перезапуска сайт сразу видел результаты.
 */
export class SnapshotStore {
  private readonly snapshots = new Map<string, { snapshot: BoardSnapshot; updatedAt: string }>();

  /** Запись файлов по одному соревнованию идёт строго по очереди. */
  private readonly writes = new Map<string, Promise<void>>();

  constructor(private readonly dir: string) {}

  async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    for (const name of await readdir(this.dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const saved = JSON.parse(await readFile(join(this.dir, name), "utf8")) as {
          snapshot: BoardSnapshot;
          updatedAt: string;
        };
        this.snapshots.set(saved.snapshot.competition.id, saved);
      } catch {
        // Повреждённый файл пропускаем: зал пришлёт свежий снимок.
      }
    }
  }

  get(id: string): BoardSnapshot | undefined {
    return this.snapshots.get(id)?.snapshot;
  }

  list(): CompetitionSummary[] {
    return [...this.snapshots.values()]
      .map(({ snapshot, updatedAt }) => ({
        id: snapshot.competition.id,
        name: snapshot.competition.name,
        discipline: snapshot.competition.discipline,
        updatedAt,
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async put(snapshot: BoardSnapshot): Promise<void> {
    const entry = { snapshot, updatedAt: new Date().toISOString() };
    this.snapshots.set(snapshot.competition.id, entry);
    // Сначала во временный файл, потом переименование: файл не останется недописанным.
    const file = join(this.dir, `${snapshot.competition.id}.json`);
    const write = (this.writes.get(snapshot.competition.id) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        await writeFile(`${file}.tmp`, JSON.stringify(entry));
        await rename(`${file}.tmp`, file);
      });
    this.writes.set(snapshot.competition.id, write);
    await write;
  }
}
