import type { SubmitMarkInput } from "@ag/shared";

export type SendOutcome = { status: "ok" } | { status: "rejected"; reason: string } | { status: "retry" };

export interface Rejected {
  mark: SubmitMarkInput;
  reason: string;
}

/**
 * Очередь оценок на планшете. Оценка сначала сохраняется локально и только потом
 * уходит на сервер, поэтому обрыв Wi-Fi или перезагрузка страницы её не теряют.
 * Повторная отправка безопасна: сервер узнаёт оценку по её id.
 */
export class MarkQueue {
  private flushing: Promise<Rejected[]> | null = null;
  private listeners = new Set<() => void>();
  private memory: SubmitMarkInput[] = [];

  constructor(
    private readonly storage: Storage,
    private readonly key: string,
    private readonly send: (mark: SubmitMarkInput) => Promise<SendOutcome>,
  ) {
    this.memory = this.load();
  }

  items(): readonly SubmitMarkInput[] {
    return this.memory;
  }

  /** Новая оценка заменяет ещё не отправленную оценку того же вида за то же выступление. */
  enqueue(mark: SubmitMarkInput): void {
    this.save([
      ...this.memory.filter((m) => !(m.performanceId === mark.performanceId && m.kind === mark.kind)),
      mark,
    ]);
  }

  /** Отправляет очередь по порядку; при обрыве связи останавливается и ждёт следующей попытки. */
  flush(): Promise<Rejected[]> {
    this.flushing ??= this.run().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async run(): Promise<Rejected[]> {
    const rejected: Rejected[] = [];
    for (const mark of [...this.memory]) {
      const outcome = await this.send(mark);
      if (outcome.status === "retry") break;
      if (outcome.status === "rejected") rejected.push({ mark, reason: outcome.reason });
      this.save(this.memory.filter((m) => m.id !== mark.id));
    }
    return rejected;
  }

  private load(): SubmitMarkInput[] {
    try {
      const raw = this.storage.getItem(this.key);
      return raw ? (JSON.parse(raw) as SubmitMarkInput[]) : [];
    } catch {
      return [];
    }
  }

  private save(items: SubmitMarkInput[]): void {
    this.memory = items;
    try {
      this.storage.setItem(this.key, JSON.stringify(items));
    } catch {
      // хранилище недоступно: очередь живёт в памяти вкладки
    }
    for (const listener of this.listeners) listener();
  }
}
