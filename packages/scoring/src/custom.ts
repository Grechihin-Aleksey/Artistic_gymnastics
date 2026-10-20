import { averageDeduction, type ExecutionOptions } from "./execution.js";
import type { Points } from "./points.js";
import type { ScoreBreakdown } from "./types.js";

/** Оценки бригады по своим правилам (юношеские разряды, школьные и региональные старты). */
export interface CustomMarks {
  /** Базовая оценка упражнения для разряда на этом снаряде. */
  base: Points;
  /** Сумма сбавок за невыполненные требования программы. */
  requirements: Points;
  /** Сбавки каждого судьи E за исполнение. */
  eDeductions: readonly Points[];
  /** Нейтральные сбавки. */
  neutral?: Points;
}

/**
 * Свои правила: итог = база − сбавки за требования − средняя сбавка E − нейтральная.
 * Крайние сбавки E отбрасываются так же, как по FIG.
 *
 * В разбивке d — стоимость упражнения (база − требования), e — средняя сбавка E
 * со знаком минус: так итог по-прежнему d + e − нейтральная, а при равенстве
 * мест выше тот, у кого сбавка меньше.
 */
export function scoreCustomPerformance(marks: CustomMarks, options: ExecutionOptions = {}): ScoreBreakdown {
  const neutral = marks.neutral ?? 0;
  for (const [name, value] of [
    ["База", marks.base],
    ["Сбавка за требования", marks.requirements],
    ["Нейтральная сбавка", neutral],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      throw new RangeError(`${name} должна быть неотрицательной: ${value}`);
    }
  }
  const d = Math.max(0, marks.base - marks.requirements);
  const e = 0 - averageDeduction(marks.eDeductions, options);
  const total = Math.max(0, d + e - neutral);
  return { d, e, neutral, total };
}
