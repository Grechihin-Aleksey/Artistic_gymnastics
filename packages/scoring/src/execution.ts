import { divideTruncated, type Points } from "./points.js";

export const MAX_E: Points = 10_000;

export interface ExecutionOptions {
  /**
   * Сколько самых больших и самых маленьких сбавок отбросить.
   * По умолчанию: 2 при семи и более судьях, 1 при четырёх–шести, 0 при меньшем числе.
   */
  drop?: number;
}

export function defaultDrop(judges: number): number {
  if (judges >= 7) return 2;
  if (judges >= 4) return 1;
  return 0;
}

/**
 * Средняя сбавка бригады E: крайние сбавки отбрасываются, остальные усредняются
 * с отбрасыванием остатка до тысячных.
 */
export function averageDeduction(deductions: readonly Points[], options: ExecutionOptions = {}): Points {
  if (deductions.length === 0) {
    throw new RangeError("Нужна хотя бы одна оценка судьи E");
  }
  for (const d of deductions) {
    if (!Number.isInteger(d) || d < 0 || d > MAX_E) {
      throw new RangeError(`Сбавка судьи E вне диапазона 0–10: ${d}`);
    }
  }
  const drop = options.drop ?? defaultDrop(deductions.length);
  const counted = deductions.length - 2 * drop;
  if (drop < 0 || counted < 1) {
    throw new RangeError(`Нельзя отбросить по ${drop} сбавки из ${deductions.length}`);
  }
  const sorted = [...deductions].sort((a, b) => a - b);
  const middle = sorted.slice(drop, sorted.length - drop);
  const sum = middle.reduce((acc, d) => acc + d, 0);
  return divideTruncated(sum, counted);
}

/** Оценка E = 10 − средняя сбавка. */
export function executionScore(deductions: readonly Points[], options: ExecutionOptions = {}): Points {
  return Math.max(0, MAX_E - averageDeduction(deductions, options));
}
