import type { INestApplication } from "@nestjs/common";
import type { AuditEntry, RotationView } from "@ag/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { splitEvenly } from "../src/competitions/rotations.service";
import { ADMIN_TOKEN, api, startApp } from "./helpers";

let app: INestApplication;
let admin: ReturnType<typeof api>;
let competitionId: string;

interface Person {
  id: string;
  bib: number;
  shift: number | null;
  startOrder: number | null;
  teamId: string | null;
}

beforeAll(async () => {
  ({ app } = await startApp());
  admin = api(app, ADMIN_TOKEN);
  competitionId = (await admin.post("/competitions", { name: "Кубок смен", discipline: "WAG" }).expect(201)).body.id;
  // 3 юношеский — 4 чел. (команда «Олимп» из двух), 2 юношеский — 3, 1 разряд — 2; смены из таблицы — у всех первая.
  const rows = [
    ...[1, 2, 3, 4].map((bib) => ({ bib, lastName: `Ю${bib}`, firstName: "А", category: "3 юношеский", shift: 1, ...(bib <= 2 ? { team: "Олимп" } : {}) })),
    ...[5, 6, 7].map((bib) => ({ bib, lastName: `Д${bib}`, firstName: "Б", category: "2 юношеский", shift: 1 })),
    ...[8, 9].map((bib) => ({ bib, lastName: `П${bib}`, firstName: "В", category: "1 разряд", shift: 1 })),
  ];
  await admin.post(`/competitions/${competitionId}/gymnasts/import`, { rows }).expect(201);
});

afterAll(async () => {
  await app?.close();
});

const distribute = (body: Record<string, unknown>) => admin.post(`/competitions/${competitionId}/shifts/distribute`, body);
const people = async () => (await api(app).get(`/competitions/${competitionId}/gymnasts`).expect(200)).body as Person[];
const shiftsOf = async () => Object.fromEntries((await people()).map((g) => [g.bib, g.shift]));

describe("деление на смены", () => {
  it("делит подряд идущие блоки как можно ровнее", () => {
    expect(splitEvenly([4, 3, 2], 2)).toEqual([1, 2, 2]);
    expect(splitEvenly([1, 1, 1, 1, 1], 2)).toEqual([1, 1, 1, 2, 2]);
    expect(splitEvenly([2, 2, 2, 2, 2, 2], 3)).toEqual([1, 1, 2, 2, 3, 3]);
  });

  it("разряды целиком: два разряда не рвутся между сменами", async () => {
    const view = (await distribute({ shifts: 2, byCategory: true }).expect(201)).body as RotationView;
    expect(view.shifts.map((s) => s.gymnastIds.length)).toEqual([4, 5]);
    expect(await shiftsOf()).toEqual({ 1: 1, 2: 1, 3: 1, 4: 1, 5: 2, 6: 2, 7: 2, 8: 2, 9: 2 });
    // Порядок выхода в смене — по номерам.
    const second = (await people()).filter((g) => g.shift === 2).sort((a, b) => a.bib - b.bib);
    expect(second.map((g) => g.startOrder)).toEqual([1, 2, 3, 4, 5]);
    await distribute({ shifts: 4, byCategory: true }).expect(400);
  });

  it("поровну: команда остаётся в одной смене, стартовый снаряд смены сохраняется", async () => {
    await admin.put(`/competitions/${competitionId}/shifts/2`, { startApparatus: "FX" }).expect(200);
    const view = (await distribute({ shifts: 3, byCategory: false }).expect(201)).body as RotationView;
    expect(view.shifts.map((s) => s.gymnastIds.length)).toEqual([3, 3, 3]);
    expect(view.shifts[1]!.startApparatus).toBe("FX");
    const s = await shiftsOf();
    expect(s[1]).toBe(s[2]);
  });

  it("без смен: все вместе, ротаций по сменам нет", async () => {
    const view = (await distribute({ shifts: 0 }).expect(201)).body as RotationView;
    expect(view.shifts).toEqual([]);
    expect(Object.values(await shiftsOf()).every((v) => v === null)).toBe(true);
    const audit = (await admin.get(`/competitions/${competitionId}/audit?group=roster`).expect(200)).body as AuditEntry[];
    expect(audit[0]!.text).toBe("Смены убраны: все участники выступают вместе");
  });

  it("после первых оценок смены не меняют", async () => {
    await distribute({ shifts: 2, byCategory: true }).expect(201);
    const [first] = await people();
    await admin.post(`/competitions/${competitionId}/judges`, { name: "Е", apparatus: "BB", role: "E", seat: 1 }).expect(201);
    await admin.post(`/competitions/${competitionId}/judges`, { name: "Д", apparatus: "BB", role: "D", seat: 1 }).expect(201);
    await admin.post(`/competitions/${competitionId}/manual-scores`, { gymnastId: first!.id, apparatus: "BB", d: 4, e: [1] }).expect(201);
    await distribute({ shifts: 0 }).expect(409);
  });
});
