/**
 * Все оценки хранятся в целых тысячных долях балла (13.466 → 13466),
 * чтобы сложение и сравнение не давали ошибок двоичной дроби.
 */
export type Points = number;

export const SCALE = 1000;

/** Перевод балла в тысячные: 8.7 → 8700. */
export function toPoints(value: number): Points {
  if (!Number.isFinite(value)) {
    throw new RangeError(`Оценка должна быть числом, получено ${value}`);
  }
  return Math.round(value * SCALE);
}

/** Перевод тысячных обратно в балл: 13466 → 13.466. */
export function fromPoints(points: Points): number {
  return points / SCALE;
}

/** Строка с тремя знаками после запятой, как в протоколах FIG. */
export function formatPoints(points: Points): string {
  const sign = points < 0 ? "-" : "";
  const abs = Math.abs(points);
  return `${sign}${Math.trunc(abs / SCALE)}.${String(abs % SCALE).padStart(3, "0")}`;
}

/** Деление с отбрасыванием остатка до тысячных (FIG не округляет вверх). */
export function divideTruncated(sum: Points, count: number): Points {
  if (count <= 0) throw new RangeError("Делитель должен быть положительным");
  return Math.trunc(sum / count);
}
