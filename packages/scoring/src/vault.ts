import { divideTruncated } from "./points.ts";
import type { ScoreBreakdown } from "./types.ts";

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
