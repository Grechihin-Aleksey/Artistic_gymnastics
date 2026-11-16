import type { PerformanceView, RecoveredPerformance } from "@ag/shared";

/** Сколько дней планшет помнит утверждённые оценки. */
const KEEP_DAYS = 7;

interface Entry extends RecoveredPerformance {
  savedAt: number;
}

/**
 * Утверждённые выступления снаряда, сохранённые на самом планшете. Резервная копия
 * базы снимается раз в 5 минут; если базу пришлось восстановить, оценки за эти
 * минуты планшеты пришлют на сервер сами, когда секретариат попросит.
 */
export class Journal {
  private readonly key: string;

  constructor(
    private readonly storage: Storage,
    competitionId: string,
    apparatus: string,
    private readonly now: () => number = Date.now,
  ) {
    this.key = `journal:${competitionId}:${apparatus}`;
  }

  /** Запоминает утверждённые выступления; уже известные обновляет (оценку могли исправить). */
  remember(list: readonly PerformanceView[]): void {
    const entries = this.load();
    let changed = false;
    for (const p of list) {
      if (p.status !== "APPROVED" || p.marks.length === 0) continue;
      const entry: Entry = {
        gymnastId: p.gymnastId,
        apparatus: p.apparatus,
        attempt: p.attempt,
        stage: p.stage ?? "QUAL",
        marks: p.marks.map((m) => ({ judgeId: m.judgeId, kind: m.kind, value: m.value })),
        savedAt: this.now(),
      };
      const id = `${entry.gymnastId}:${entry.attempt}:${entry.stage}`;
      const old = entries[id];
      if (old && JSON.stringify(old.marks) === JSON.stringify(entry.marks)) continue;
      entries[id] = entry;
      changed = true;
    }
    if (changed) this.save(entries);
  }

  /** Всё, что помнит планшет, для отправки на сервер. */
  all(): RecoveredPerformance[] {
    return Object.values(this.load()).map(({ savedAt: _savedAt, ...rest }) => rest);
  }

  private load(): Record<string, Entry> {
    try {
      const raw = JSON.parse(this.storage.getItem(this.key) ?? "{}") as Record<string, Entry>;
      const fresh = this.now() - KEEP_DAYS * 24 * 3600 * 1000;
      return Object.fromEntries(Object.entries(raw).filter(([, e]) => e && e.savedAt >= fresh));
    } catch {
      return {};
    }
  }

  private save(entries: Record<string, Entry>): void {
    try {
      this.storage.setItem(this.key, JSON.stringify(entries));
    } catch {
      // память браузера заполнена — оценки всё равно есть на сервере
    }
  }
}
