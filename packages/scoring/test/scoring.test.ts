import { describe, expect, it } from "vitest";
import {
  FINAL_5_3_3,
  QUALIFICATION_5_4_3,
  averageVaults,
  executionScore,
  formatPoints,
  rank,
  rankAllAround,
  rankApparatus,
  rankTeams,
  scorePerformance,
  teamTotal,
  toPoints,
  type ScoreBreakdown,
} from "../src/index.js";

const p = toPoints;
const score = (total: number, e = 8, d = total - e): ScoreBreakdown => ({
  d: p(d),
  e: p(e),
  neutral: 0,
  total: p(total),
});

describe("тысячные доли", () => {
  it("переводит баллы без ошибок двоичной дроби", () => {
    expect(p(0.1) + p(0.2)).toBe(p(0.3));
    expect(formatPoints(p(13.466))).toBe("13.466");
    expect(formatPoints(p(9.05))).toBe("9.050");
    expect(formatPoints(0)).toBe("0.000");
  });
});

describe("оценка E", () => {
  it("при пяти судьях отбрасывает самую большую и самую маленькую сбавку", () => {
    expect(executionScore([1.2, 1.4, 1.3, 1.6, 1.1].map(p))).toBe(p(8.7));
  });

  it("отбрасывает остаток после тысячных", () => {
    // (1.1 + 1.1 + 1.2) / 3 = 1.1333…
    expect(executionScore([1.0, 1.1, 1.1, 1.2, 1.5].map(p))).toBe(p(8.867));
  });

  it("при семи судьях отбрасывает по две крайние сбавки", () => {
    // (1.0 + 1.0 + 1.1) / 3 = 1.0333…
    expect(executionScore([0.5, 0.9, 1.0, 1.0, 1.1, 1.2, 2.0].map(p))).toBe(p(8.967));
  });

  it("при трёх судьях усредняет все сбавки", () => {
    expect(executionScore([1.0, 1.2, 1.4].map(p))).toBe(p(8.8));
  });

  it("отклоняет некорректные сбавки", () => {
    expect(() => executionScore([])).toThrow(RangeError);
    expect(() => executionScore([p(-0.1)])).toThrow(RangeError);
    expect(() => executionScore([p(10.1)])).toThrow(RangeError);
    expect(() => executionScore([1, 2, 3].map(p), { drop: 2 })).toThrow(RangeError);
  });
});

describe("оценка за выступление", () => {
  it("складывает D и E и вычитает нейтральные сбавки", () => {
    const result = scorePerformance({
      d: p(5.8),
      eDeductions: [1.2, 1.4, 1.3, 1.6, 1.1].map(p),
      neutral: p(0.1),
    });
    expect(result).toEqual({ d: p(5.8), e: p(8.7), neutral: p(0.1), total: p(14.4) });
  });

  it("не опускает итог ниже нуля", () => {
    const result = scorePerformance({ d: 0, eDeductions: [p(10)], neutral: p(1) });
    expect(result.total).toBe(0);
  });
});

describe("опорный прыжок", () => {
  it("в финале берёт среднее двух прыжков", () => {
    const first = { d: p(5.6), e: p(8.9), neutral: 0, total: p(14.5) };
    const second = { d: p(5.4), e: p(8.933), neutral: p(0.1), total: p(14.233) };
    expect(averageVaults(first, second)).toEqual({
      d: p(5.5),
      e: p(8.916),
      neutral: p(0.05),
      total: p(14.366),
    });
  });
});

describe("места", () => {
  it("делит место при полном равенстве и пропускает следующее", () => {
    const ranked = rank([10, 12, 12, 9], (x) => [x]);
    expect(ranked.map((r) => [r.item, r.rank])).toEqual([
      [12, 1],
      [12, 1],
      [10, 3],
      [9, 4],
    ]);
  });

  it("на снаряде при равной оценке выше тот, у кого больше E, затем больше D", () => {
    const ranked = rankApparatus([
      { id: "a", score: score(14.5, 8.5) },
      { id: "b", score: score(14.5, 8.7) },
      { id: "c", score: { d: p(5.9), e: p(8.7), neutral: p(0.1), total: p(14.5) } },
    ]);
    expect(ranked.map((r) => [r.item.id, r.rank])).toEqual([
      ["c", 1],
      ["b", 2],
      ["a", 3],
    ]);
  });
});

describe("многоборье", () => {
  it("складывает четыре снаряда у женщин и решает равенство без самой низкой оценки", () => {
    const ranked = rankAllAround("WAG", [
      { id: "anna", scores: { VT: score(14), UB: score(13), BB: score(13), FX: score(12) } },
      { id: "vera", scores: { VT: score(13), UB: score(13), BB: score(13), FX: score(13) } },
      { id: "olga", scores: { VT: score(14), UB: score(14), BB: score(14) } },
    ]);
    expect(ranked.map((r) => [r.item.id, r.rank, r.item.total, r.item.complete])).toEqual([
      ["anna", 1, p(52), true],
      ["vera", 2, p(52), true],
      ["olga", 3, p(42), false],
    ]);
  });

  it("у мужчин считает шесть снарядов", () => {
    const [first] = rankAllAround("MAG", [
      {
        id: "ivan",
        scores: { FX: score(14), PH: score(13), SR: score(13.5), VT: score(14.2), PB: score(14.1), HB: score(13.3) },
      },
    ]);
    expect(first?.item.total).toBe(p(82.1));
    expect(first?.item.tieBreak).toBe(p(82.1 - 13));
  });
});

describe("командный зачёт", () => {
  const member = (id: string, totals: Partial<Record<"VT" | "UB" | "BB" | "FX", number>>) => ({
    id,
    scores: Object.fromEntries(Object.entries(totals).map(([a, t]) => [a, score(t)])),
  });

  it("5-4-3: из четырёх оценок на снаряде идут в зачёт три лучшие", () => {
    const result = teamTotal("WAG", QUALIFICATION_5_4_3, {
      id: "team",
      members: [
        member("m1", { VT: 14, UB: 13, BB: 12, FX: 12 }),
        member("m2", { VT: 13, UB: 14, BB: 13, FX: 13 }),
        member("m3", { VT: 12, UB: 12, BB: 14, FX: 11 }),
        member("m4", { VT: 11, UB: 11, BB: 11, FX: 14 }),
        member("m5", {}),
      ],
    });
    const vt = result.byApparatus.find((a) => a.apparatus === "VT");
    expect(vt).toEqual({ apparatus: "VT", total: p(39), counted: ["m1", "m2", "m3"] });
    expect(result.total).toBe(p(39 + 39 + 39 + 39));
  });

  it("5-3-3: не допускает четвёртого участника на снаряде", () => {
    expect(() =>
      teamTotal("WAG", FINAL_5_3_3, {
        id: "team",
        members: [
          member("m1", { VT: 14 }),
          member("m2", { VT: 13 }),
          member("m3", { VT: 12 }),
          member("m4", { VT: 11 }),
        ],
      }),
    ).toThrow(RangeError);
  });

  it("при равной сумме выше команда, у которой лучше сумма без самой низкой зачётной оценки", () => {
    const ranked = rankTeams("WAG", FINAL_5_3_3, [
      {
        id: "a",
        members: [member("a1", { VT: 14, UB: 14, BB: 14, FX: 10 }), member("a2", { VT: 14 }), member("a3", { VT: 14 })],
      },
      {
        id: "b",
        members: [member("b1", { VT: 14, UB: 14, BB: 13, FX: 11 }), member("b2", { VT: 14 }), member("b3", { VT: 14 })],
      },
    ]);
    expect(ranked.map((r) => [r.item.id, r.rank])).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
  });
});
