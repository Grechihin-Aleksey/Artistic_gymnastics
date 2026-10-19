import { executionScore, type ExecutionOptions } from "./execution.js";
import type { PanelMarks, ScoreBreakdown } from "./types.js";

/** Оценка за выступление: D + E − нейтральные сбавки, не ниже нуля. */
export function scorePerformance(marks: PanelMarks, options: ExecutionOptions = {}): ScoreBreakdown {
  const neutral = marks.neutral ?? 0;
  if (!Number.isInteger(marks.d) || marks.d < 0) {
    throw new RangeError(`Оценка D должна быть неотрицательной: ${marks.d}`);
  }
  if (!Number.isInteger(neutral) || neutral < 0) {
    throw new RangeError(`Нейтральная сбавка должна быть неотрицательной: ${neutral}`);
  }
  const e = executionScore(marks.eDeductions, options);
  const total = Math.max(0, marks.d + e - neutral);
  return { d: marks.d, e, neutral, total };
}
