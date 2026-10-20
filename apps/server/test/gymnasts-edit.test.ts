import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, api, startApp } from "./helpers";

let app: INestApplication;
let admin: ReturnType<typeof api>;
let competitionId: string;
const ids = new Map<number, string>();

beforeAll(async () => {
  ({ app } = await startApp());
  admin = api(app, ADMIN_TOKEN);
  competitionId = (await admin.post("/competitions", { name: "Первенство", discipline: "WAG" }).expect(201)).body.id;
  const rows = [
    { bib: 1, lastName: "Иванва", firstName: "Анна", team: "Школа 5", category: "1 юношеский", shift: 1 },
    { bib: 2, lastName: "Петрова", firstName: "Мария", team: "Школа 5", category: "1 юношеский", shift: 1 },
    { bib: 3, lastName: "Сидорова", firstName: "Вера", category: "1 юношеский", shift: 1 },
    { bib: 4, lastName: "Козлова", firstName: "Яна", category: "2 юношеский", shift: 2 },
  ];
  for (const g of (await admin.post(`/competitions/${competitionId}/gymnasts/import`, { rows }).expect(201)).body) {
    ids.set(g.bib, g.id);
  }
});

afterAll(async () => {
  await app?.close();
});

const path = (bib: number) => `/competitions/${competitionId}/gymnasts/${ids.get(bib)}`;
const rotation = async () => (await api(app).get(`/competitions/${competitionId}/rotation`).expect(200)).body;

describe("правка участников", () => {
  it("исправляет фамилию, номер, разряд, команду и смену", async () => {
    await api(app).patch(path(1), { lastName: "Иванова" }).expect(401);
    const fixed = (await admin.patch(path(1), { lastName: "Иванова", bib: 11 }).expect(200)).body;
    expect(fixed).toMatchObject({ lastName: "Иванова", bib: 11, firstName: "Анна" });
    expect((await admin.patch(path(1), { bib: 2 }).expect(409)).body.message).toContain("Петрова");

    // В другую смену — последней в очереди; в новый разряд — вместе с командой этого разряда.
    const moved = (await admin.patch(path(3), { shift: 2, category: "2 юношеский", team: "Олимп" }).expect(200)).body;
    expect(moved.shift).toBe(2);
    const shift2 = (await rotation()).shifts.find((s: { number: number }) => s.number === 2);
    expect(shift2.gymnastIds).toEqual([ids.get(4), ids.get(3)]);
    const teams = (await api(app).get(`/competitions/${competitionId}/teams`).expect(200)).body;
    const categories = (await api(app).get(`/competitions/${competitionId}/categories`).expect(200)).body;
    const olimp = teams.find((t: { name: string }) => t.name === "Олимп");
    expect(olimp.categoryId).toBe(categories.find((c: { name: string }) => c.name === "2 юношеский").id);
    expect(moved.teamId).toBe(olimp.id);

    // Новый разряд создаётся по названию; пустое значение убирает команду.
    const solo = (await admin.patch(path(3), { category: "3 юношеский", team: null }).expect(200)).body;
    expect(solo.teamId).toBeNull();
    expect((await api(app).get(`/competitions/${competitionId}/categories`).expect(200)).body.map((c: { name: string }) => c.name)).toContain(
      "3 юношеский",
    );
  });

  it("неявка и снятие: не в очереди, не вызываются, не в многоборье", async () => {
    await admin.patch(path(2), { status: "DNS" }).expect(200);
    const shift1 = (await rotation()).shifts.find((s: { number: number }) => s.number === 1);
    expect(shift1.gymnastIds).toEqual([ids.get(1)]);

    const sv = (
      await admin.post(`/competitions/${competitionId}/judges`, { name: "СС", apparatus: "VT", role: "SUPERVISOR", seat: 1, enterAllMarks: true }).expect(201)
    ).body.token as string;
    for (const role of ["D", "E"]) {
      await admin.post(`/competitions/${competitionId}/judges`, { name: role, apparatus: "VT", role, seat: 1 }).expect(201);
    }
    const judge = api(app, sv);
    const refused = await judge.post(`/competitions/${competitionId}/performances`, { gymnastId: ids.get(2), apparatus: "VT" }).expect(409);
    expect(refused.body.message).toContain("неявка");

    // Выступила на одном снаряде и снялась: оценка на снаряде остаётся, в многоборье её нет.
    const perf = (await judge.post(`/competitions/${competitionId}/performances`, { gymnastId: ids.get(1), apparatus: "VT" }).expect(201)).body;
    await judge.post(`/performances/${perf.id}/tablet-score`, { d: 4, e: [1] }).expect(201);
    await admin.patch(path(1), { status: "WITHDRAWN" }).expect(200);
    const vault = (await api(app).get(`/competitions/${competitionId}/results/apparatus/VT`).expect(200)).body;
    expect(vault.map((r: { gymnast: { id: string } }) => r.gymnast.id)).toEqual([ids.get(1)]);
    const aa = (await api(app).get(`/competitions/${competitionId}/results/all-around`).expect(200)).body;
    expect(aa).toEqual([]);

    // Выступавшего не удалить и не перевести в другой разряд.
    expect((await admin.delete(path(1)).expect(409)).body.message).toContain("снятие");
    expect((await admin.patch(path(1), { category: "2 юношеский" }).expect(409)).body.message).toContain("разряд");
    await admin.delete(path(2)).expect(200);
    await admin.patch(path(2), { status: "ACTIVE" }).expect(404);
  });
});
