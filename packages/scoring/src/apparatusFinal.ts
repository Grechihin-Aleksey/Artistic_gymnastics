import { rank, type Ranked } from "./ranking.ts";
import type { ScoreBreakdown } from "./types.ts";

export interface ApparatusEntry<Id = string> {
  id: Id;
  /** Для опорного прыжка в финале — результат averageVaults. */
  score: ScoreBreakdown;
}

/** Места на снаряде: общая оценка, при равенстве выше E, затем выше D. */
export function rankApparatus<Id>(entries: readonly ApparatusEntry<Id>[]): Ranked<ApparatusEntry<Id>>[] {
  return rank(entries, (e) => [e.score.total, e.score.e, e.score.d]);
}
