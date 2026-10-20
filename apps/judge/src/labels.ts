import type { JudgeRole, MarkKind, Rules } from "@ag/shared";

export { APPARATUS_NAMES } from "@ag/shared";

export const ROLE_NAMES: Record<JudgeRole, string> = {
  D: "Судья D",
  E: "Судья E",
  SUPERVISOR: "Старший судья",
};

export const KIND_NAMES: Record<MarkKind, string> = {
  D: "Оценка D",
  E: "Сбавка E",
  NEUTRAL: "Нейтральная сбавка",
};

/** Название оценки с учётом правил: по своим правилам судья D ставит сбавки за требования. */
export function kindName(kind: MarkKind, rules: Rules | undefined): string {
  return kind === "D" && rules === "CUSTOM" ? "Сбавки за требования" : KIND_NAMES[kind];
}

/** Прибавляет сбавку из списка к набранному значению; результат в формате поля ввода. */
export function addDeduction(text: string, value: number): string {
  const current = Number(text.trim().replace(",", ".")) || 0;
  return String(Math.round((current + value) * 1000) / 1000);
}

export const KINDS_BY_ROLE: Record<JudgeRole, MarkKind[]> = {
  D: ["D", "NEUTRAL"],
  E: ["E"],
  SUPERVISOR: ["D", "NEUTRAL"],
};

export function judgeLabel(role: JudgeRole, seat: number): string {
  return role === "SUPERVISOR" ? "СС" : `${role}${seat}`;
}

/** Проверка ввода с клавиатуры: до двух цифр целой части и до трёх после точки. */
export function parseScore(input: string, kind: MarkKind): number | null {
  if (!/^\d{1,2}(\.\d{1,3})?$/.test(input)) return null;
  const value = Number(input);
  const max = kind === "D" ? 20 : 10;
  return value <= max ? value : null;
}

/** Очки за места из положения: «10 8 6,5 5» → [10, 8, 6.5, 5]; null — если есть ошибка. */
export function parsePoints(text: string): number[] | null {
  // Запятая — десятичный знак (1,5 очка), числа разделяются пробелами или «;».
  const parts = text.split(/[\s;]+/).filter(Boolean);
  const values = parts.map((p) => Number(p.replace(",", ".")));
  return values.every((v) => Number.isFinite(v) && v >= 0 && v <= 1000 && Number.isInteger(v * 2)) && values.length <= 60
    ? values
    : null;
}
