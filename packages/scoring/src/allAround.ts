import { rank, type Ranked } from "./ranking.js";
import { apparatusFor, type Apparatus, type Discipline, type ScoreBreakdown } from "./types.js";
import type { Points } from "./points.js";

export interface AllAroundEntry<Id = string> {
  id: Id;
  /** Оценки по снарядам; для опорного прыжка — только первый прыжок. */
  scores: Partial<Record<Apparatus, ScoreBreakdown>>;
}

export interface AllAroundResult<Id = string> {
  id: Id;
  total: Points;
  /** Сумма без самых низких оценок, для разрешения равенства. */
  tieBreak: Points;
  /** Выступил ли участник на всех снарядах программы. */
  complete: boolean;
}

export interface AllAroundOptions {
  /** Сколько самых низких оценок отбросить при равенстве суммы. По умолчанию 1. */
  tieBreakDrop?: number;
}

export function allAroundTotal<Id>(
  discipline: Discipline,
  entry: AllAroundEntry<Id>,
  options: AllAroundOptions = {},
): AllAroundResult<Id> {
  const apparatus = apparatusFor(discipline);
  const totals = apparatus.map((a) => entry.scores[a]?.total ?? 0);
  const total = totals.reduce((acc, t) => acc + t, 0);
  const drop = options.tieBreakDrop ?? 1;
  const tieBreak = [...totals]
    .sort((a, b) => b - a)
    .slice(0, Math.max(0, totals.length - drop))
    .reduce((acc, t) => acc + t, 0);
  const complete = apparatus.every((a) => entry.scores[a] !== undefined);
  return { id: entry.id, total, tieBreak, complete };
}

/** Таблица многоборья: сумма, затем сумма без самой низкой оценки. */
export function rankAllAround<Id>(
  discipline: Discipline,
  entries: readonly AllAroundEntry<Id>[],
  options: AllAroundOptions = {},
): Ranked<AllAroundResult<Id>>[] {
  const results = entries.map((e) => allAroundTotal(discipline, e, options));
  return rank(results, (r) => [r.total, r.tieBreak]);
}
