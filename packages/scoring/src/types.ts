import type { Points } from "./points.ts";

export type Discipline = "MAG" | "WAG";

export const MAG_APPARATUS = ["FX", "PH", "SR", "VT", "PB", "HB"] as const;
export const WAG_APPARATUS = ["VT", "UB", "BB", "FX"] as const;

export type MagApparatus = (typeof MAG_APPARATUS)[number];
export type WagApparatus = (typeof WAG_APPARATUS)[number];
export type Apparatus = MagApparatus | WagApparatus;

export function apparatusFor(discipline: Discipline): readonly Apparatus[] {
  return discipline === "MAG" ? MAG_APPARATUS : WAG_APPARATUS;
}

/** Оценки бригады за одно выступление (одну попытку прыжка). */
export interface PanelMarks {
  /** Оценка D, утверждённая бригадой D. */
  d: Points;
  /** Сумма сбавок каждого судьи E. */
  eDeductions: readonly Points[];
  /** Нейтральные сбавки: линия, время, поведение, форма. */
  neutral?: Points;
}

/** Итог одного выступления. */
export interface ScoreBreakdown {
  d: Points;
  e: Points;
  neutral: Points;
  total: Points;
}
