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
  /**
   * Суммы для разрешения равенства по правилам FIG: без самой низкой оценки,
   * если снова равенство — без двух самых низких, и так далее до одной лучшей.
   */
  tieBreaks: Points[];
  /** Выступил ли участник на всех снарядах программы. */
  complete: boolean;
}

export interface AllAroundOptions {
  /** Сколько самых низких оценок отбросить при равенстве суммы сначала. По умолчанию 1. */
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
  const sorted = [...totals].sort((a, b) => b - a);
  const tieBreaks: Points[] = [];
  for (let drop = Math.max(0, options.tieBreakDrop ?? 1); drop < sorted.length; drop++) {
    tieBreaks.push(sorted.slice(0, sorted.length - drop).reduce((acc, t) => acc + t, 0));
  }
  const tieBreak = tieBreaks[0] ?? 0;
  const complete = apparatus.every((a) => entry.scores[a] !== undefined);
  return { id: entry.id, total, tieBreak, tieBreaks, complete };
}

/**
 * Таблица многоборья по правилам FIG: сумма, при равенстве — сумма без самой
 * низкой оценки, затем без двух самых низких и так далее. Если совпало и это,
 * участники делят место.
 */
export function rankAllAround<Id>(
  discipline: Discipline,
  entries: readonly AllAroundEntry<Id>[],
  options: AllAroundOptions = {},
): Ranked<AllAroundResult<Id>>[] {
  const results = entries.map((e) => allAroundTotal(discipline, e, options));
  return rank(results, (r) => [r.total, ...r.tieBreaks]);
}
