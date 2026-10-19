import type { JudgeRole, MarkKind } from "@ag/shared";

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
