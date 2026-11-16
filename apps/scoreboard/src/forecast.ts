import type { BoardSnapshot, FinalsView, RotationView } from "@ag/shared";

type Apparatus = BoardSnapshot["live"][number]["apparatus"];

export interface QueuePerson {
  id: string;
  bib: number;
  firstName: string;
  lastName: string;
  club: string | null;
  categoryId: string | null;
  status?: "ACTIVE" | "DNS" | "WITHDRAWN";
}

export interface Queue {
  queue: QueuePerson[];
  /** В этой ротации на снаряде нет смены. */
  idle: boolean;
  /** Кто-то выступает прямо сейчас. */
  busy: boolean;
  /** На снаряде уже начали: есть оценки или вызванный участник. */
  started: boolean;
}

/** Темп, пока оценок на снаряде мало: полторы минуты на участника. */
export const DEFAULT_PACE_S = 90;

/**
 * Кто ещё выйдет на снаряд в этой ротации, по порядку: по смене (в финале — по составу
 * финала, без смен — по номерам), без уже получивших оценку и выступающего сейчас.
 */
export function upcoming(
  data: BoardSnapshot,
  rotation: RotationView | null,
  finals: FinalsView | null,
  people: readonly QueuePerson[],
): Map<Apparatus, Queue> {
  const byId = new Map(people.map((p) => [p.id, p]));
  const isFinal = data.competition.phase === "FINAL";
  const result = new Map<Apparatus, Queue>();
  for (const live of data.live) {
    const app = live.apparatus;
    const done = new Set<string>();
    for (const c of data.categories) for (const row of c.apparatus[app] ?? []) done.add(row.gymnast.id);
    if (live.current) done.add(live.current.gymnast.id);

    // Без смен — как у старшего судьи: все участники по возрастанию номеров.
    const noShifts = !rotation || rotation.shifts.length === 0;
    const shiftsHere = (rotation?.shifts ?? []).filter((s) => s.apparatus === app);
    const order: string[] = isFinal
      ? (finals?.lists ?? []).filter((l) => l.apparatus === app).flatMap((l) => l.finalists.filter((f) => !f.reserve).map((f) => f.gymnast.id))
      : noShifts
        ? [...people].sort((a, b) => a.bib - b.bib).map((p) => p.id)
        : shiftsHere.flatMap((s) => s.gymnastIds);
    const queue = order
      .filter((id) => !done.has(id))
      .map((id) => byId.get(id))
      .filter((p): p is QueuePerson => Boolean(p) && (p!.status ?? "ACTIVE") === "ACTIVE");
    result.set(app, {
      queue,
      idle: !isFinal && !noShifts && shiftsHere.length === 0,
      busy: Boolean(live.current),
      started: Boolean(live.current) || [...done].length > 0,
    });
  }
  return result;
}

export interface Forecast {
  apparatus: Apparatus;
  /** Сколько участников выступит раньше, не считая того, кто на снаряде сейчас. */
  ahead: number;
  /** Через сколько минут примерно выйдет. */
  minutes: number;
  /** Примерное время выхода. */
  at: Date;
}

/**
 * Когда участник примерно выйдет на снаряды текущей ротации. Выступающему сейчас
 * отводим половину темпа, каждому перед ним — целый темп снаряда.
 */
export function forecastFor(
  gymnastId: string,
  queues: ReturnType<typeof upcoming>,
  pace: RotationView["pace"],
  now: Date,
): Forecast[] {
  const out: Forecast[] = [];
  for (const [apparatus, { queue, busy, started }] of queues) {
    // Снаряд, где ещё не начинали, не прогнозируем: без смен очередь там — все участники подряд.
    if (!started) continue;
    const ahead = queue.findIndex((p) => p.id === gymnastId);
    if (ahead < 0) continue;
    const step = pace?.[apparatus] ?? DEFAULT_PACE_S;
    const seconds = (busy ? step / 2 : 0) + ahead * step;
    out.push({ apparatus, ahead, minutes: Math.round(seconds / 60), at: new Date(now.getTime() + seconds * 1000) });
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}
