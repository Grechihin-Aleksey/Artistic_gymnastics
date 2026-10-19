import { apparatusFor, type Apparatus, type Discipline } from "./types.js";

/**
 * Снаряд смены в ротации `rotation` (с нуля): смены переходят по олимпийскому
 * порядку снарядов, начиная со стартового.
 */
export function shiftApparatus(discipline: Discipline, start: Apparatus, rotation: number): Apparatus {
  const order = apparatusFor(discipline);
  const from = order.indexOf(start);
  if (from < 0) throw new RangeError(`Снаряда ${start} нет в программе ${discipline}`);
  return order[(from + rotation) % order.length]!;
}

/**
 * Порядок выхода смены в ротации: по правилам FIG после каждой ротации
 * первый участник уходит в конец.
 */
export function rotationOrder<T>(startOrder: readonly T[], rotation: number): T[] {
  if (startOrder.length === 0) return [];
  const shift = rotation % startOrder.length;
  return [...startOrder.slice(shift), ...startOrder.slice(0, shift)];
}

/** Стартовый снаряд смены по умолчанию: смены по очереди занимают снаряды. */
export function defaultStart(discipline: Discipline, shiftNumber: number): Apparatus {
  const order = apparatusFor(discipline);
  return order[(shiftNumber - 1) % order.length]!;
}
