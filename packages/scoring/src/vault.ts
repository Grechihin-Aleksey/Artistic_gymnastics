import { divideTruncated } from "./points.js";
import type { ScoreBreakdown } from "./types.js";

/**
 * Лучший из двух прыжков: выше общая оценка, при равенстве выше E, затем D.
 * Так считают многие первенства по своим правилам и юношеские разряды.
 */
export function bestVault(first: ScoreBreakdown, second: ScoreBreakdown): ScoreBreakdown {
  const better =
    second.total - first.total || second.e - first.e || second.d - first.d;
  return better > 0 ? second : first;
}

/**
 * Итог опорного прыжка в финале на снаряде (и в квалификации к нему):
 * среднее двух прыжков, отдельно по D, E и общей оценке.
 */
export function averageVaults(first: ScoreBreakdown, second: ScoreBreakdown): ScoreBreakdown {
  return {
    d: divideTruncated(first.d + second.d, 2),
    e: divideTruncated(first.e + second.e, 2),
    neutral: divideTruncated(first.neutral + second.neutral, 2),
    total: divideTruncated(first.total + second.total, 2),
  };
}
