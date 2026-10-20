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
  const current = Number(expandScore(text)) || 0;
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

/**
 * Быстрый ввод без точки: первая цифра — целые, остальные — сотые и тысячные.
 * «9» → «9.00», «95» → «9.50», «955» → «9.55», «05» → «0.50». С точкой или запятой
 * число остаётся как набрано, только дополняется до сотых: «10.» → «10.00».
 */
export function expandScore(input: string): string {
  const text = input.trim().replace(",", ".");
  const short = /^(\d)(\d{0,3})$/.exec(text);
  if (short) return `${short[1]}.${short[2]!.padEnd(2, "0")}`;
  const full = /^(\d{1,2})\.(\d{0,3})$/.exec(text);
  if (full) return `${full[1]}.${full[2]!.padEnd(2, "0")}`;
  return text;
}

/** Проверка ввода с клавиатуры: до двух цифр целой части и до трёх после точки. */
export function parseScore(input: string, kind: MarkKind): number | null {
  if (!/^\d{1,2}(\.\d{1,3})?$/.test(input)) return null;
  const value = Number(input);
  const max = kind === "D" ? 20 : 10;
  return value <= max ? value : null;
}

/** Допуск расхождения сбавок судей E: больше — старший судья видит предупреждение. */
export const E_TOLERANCE = 0.5;

/** Предупреждение, если сбавки судей E расходятся больше допуска; null — всё в порядке. */
export function eSpreadWarning(values: number[]): string | null {
  if (values.length < 2) return null;
  const spread = Math.round((Math.max(...values) - Math.min(...values)) * 1000) / 1000;
  return spread > E_TOLERANCE
    ? `Сбавки судей E расходятся на ${spread.toFixed(2)} (допуск ${E_TOLERANCE.toFixed(2)}). Проверьте перед утверждением`
    : null;
}

/** Предельное время упражнения по правилам FIG, секунды; null — на снаряде время не ограничено. */
export function timeLimit(discipline: string, apparatus: string): number | null {
  if (discipline === "WAG") return apparatus === "BB" || apparatus === "FX" ? 90 : null;
  if (discipline === "MAG") return apparatus === "FX" ? 70 : null;
  return null;
}

/** Время секундомера: «1:05.3». */
export function formatTime(ms: number): string {
  const tenths = Math.floor(ms / 100);
  const minutes = Math.floor(tenths / 600);
  const seconds = Math.floor((tenths % 600) / 10);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${tenths % 10}`;
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
