import type { Discipline } from "./types.js";

/**
 * Оценка работы судьи E по таблице FIG «Examination Table — Difference from Expert
 * Deductions» (Specific Judges' Rules 2025–2028, ст. 2.1.2, отдельно для женщин и
 * мужчин). Строка — по контрольной сбавке, столбец — по отклонению судьи от неё
 * с шагом 0.1 (последний столбец — больше 1.4). В зале экспертов нет, поэтому
 * контрольной считаем итоговую сбавку бригады (10 − оценка E).
 */
const ROWS = [0.4, 0.6, 1.0, 1.5, 2.0, 2.5, Infinity];

const pad = (row: number[]) => [...row, ...Array<number>(16 - row.length).fill(0)];

const TABLES: Record<Discipline, number[][]> = {
  WAG: [
    [100, 100, 75, 65, 55, 45, 35, 25, 15, 5],
    [100, 100, 80, 70, 60, 50, 40, 30, 20, 10],
    [100, 100, 100, 80, 70, 60, 50, 40, 30, 20, 10],
    [100, 100, 100, 90, 80, 70, 60, 50, 40, 30, 20, 10],
    [100, 100, 100, 100, 90, 80, 70, 60, 50, 40, 30, 20, 10],
    [100, 100, 100, 100, 95, 85, 80, 70, 60, 50, 40, 30, 20, 10],
    [100, 100, 100, 100, 100, 95, 85, 80, 70, 60, 50, 40, 30, 20, 10],
  ].map(pad),
  MAG: [
    [100, 75, 65, 55, 45, 35, 25, 15, 5],
    [100, 80, 70, 60, 50, 40, 30, 20, 10],
    [100, 100, 80, 70, 60, 50, 40, 30, 20, 10],
    [100, 100, 94, 80, 70, 60, 50, 40, 30, 20, 10],
    [100, 100, 100, 90, 80, 70, 60, 50, 40, 30, 20, 10],
    [100, 100, 100, 96, 88, 80, 70, 60, 50, 40, 30, 20, 10],
    [100, 100, 100, 100, 93, 87, 80, 70, 60, 50, 40, 30, 20, 10],
  ].map(pad),
};

/** Процент за одно выступление: контрольная сбавка и сбавка судьи, в баллах. */
export function eJudgePercent(discipline: Discipline, reference: number, deduction: number): number {
  const row = ROWS.findIndex((limit) => reference <= limit + 1e-9);
  // Отклонение округляем до десятых: 0.05 и больше — вверх.
  const column = Math.min(15, Math.round(Math.abs(deduction - reference) * 10 + 1e-9));
  return TABLES[discipline][row]![column]!;
}

/** Оценка по итоговому проценту (FIG, женщины, ст. 2.2). */
export function eJudgeBand(percent: number): string {
  if (percent >= 92) return "отлично";
  if (percent >= 87) return "очень хорошо";
  if (percent >= 80) return "хорошо";
  if (percent >= 75) return "зачёт";
  return "незачёт";
}

export interface EJudgeSample {
  judgeId: string;
  /** Сбавка судьи, баллы. */
  deduction: number;
  /** Итоговая сбавка бригады (10 − оценка E), баллы. */
  reference: number;
}

export interface EJudgeSummary {
  judgeId: string;
  count: number;
  /** Среднее отклонение со знаком: плюс — судья строже бригады, минус — мягче. */
  bias: number;
  /** Среднее отклонение по модулю. */
  meanAbs: number;
  maxAbs: number;
  /** Выступлений, где отклонение больше 0.3. */
  over03: number;
  /** Средний процент по таблице FIG. */
  percent: number;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function summarizeEJudges(discipline: Discipline, samples: readonly EJudgeSample[]): EJudgeSummary[] {
  const byJudge = new Map<string, EJudgeSample[]>();
  for (const s of samples) byJudge.set(s.judgeId, [...(byJudge.get(s.judgeId) ?? []), s]);
  return [...byJudge].map(([judgeId, list]) => {
    const diffs = list.map((s) => s.deduction - s.reference);
    const abs = diffs.map(Math.abs);
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    return {
      judgeId,
      count: list.length,
      bias: round3(sum(diffs) / list.length),
      meanAbs: round3(sum(abs) / list.length),
      maxAbs: round3(Math.max(...abs)),
      over03: abs.filter((d) => d > 0.3 + 1e-9).length,
      percent: Math.round((sum(list.map((s) => eJudgePercent(discipline, s.reference, s.deduction))) / list.length) * 100) / 100,
    };
  });
}
