import { describe, expect, it } from "vitest";
import { paceFrom } from "../src/competitions/rotations.service";

const at = (min: number, sec = 0) => new Date(Date.UTC(2026, 10, 16, 10, min, sec));

describe("темп снаряда для прогноза", () => {
  it("медиана интервалов между оценками, перерывы не считаются", () => {
    expect(paceFrom([at(0)])).toBeUndefined();
    expect(paceFrom([at(0), at(1, 30)])).toBeUndefined();
    // 90 с, 120 с, перерыв 20 минут, 100 с.
    expect(paceFrom([at(0), at(1, 30), at(3, 30), at(23, 30), at(25, 10)])).toBe(100);
    expect(paceFrom([at(3, 30), at(0), at(1, 30)])).toBe(105);
  });
});
