import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, api, startApp } from "./helpers";

let app: INestApplication;
let admin: ReturnType<typeof api>;
let competitionId: string;

interface Row {
  id: string;
  bib: number;
  lastName: string;
  teamId: string | null;
  shift: number | null;
  startOrder: number | null;
}

beforeAll(async () => {
  ({ app } = await startApp());
  admin = api(app, ADMIN_TOKEN);
  competitionId = (await admin.post("/competitions", { name: "Первенство", discipline: "WAG" }).expect(201)).body.id;
  const rows = [
    ...["А1", "А2", "А3"].map((n, i) => ({ bib: 101 + i, lastName: n, firstName: "А", team: "Альфа", shift: 1 })),
    ...["Б1", "Б2", "Б3"].map((n, i) => ({ bib: 201 + i, lastName: n, firstName: "Б", team: "Бета", shift: 1 })),
    ...["В1", "В2"].map((n, i) => ({ bib: 301 + i, lastName: n, firstName: "В", shift: 1 })),
    ...["Г1", "Г2", "Г3"].map((n, i) => ({ bib: 401 + i, lastName: n, firstName: "Г", shift: 2 })),
  ];
  await admin.post(`/competitions/${competitionId}/gymnasts/import`, { rows }).expect(201);
});

afterAll(async () => {
  await app?.close();
});

const list = async (): Promise<Row[]> => (await api(app).get(`/competitions/${competitionId}/gymnasts`).expect(200)).body;

describe("жеребьёвка", () => {
  it("случайная: номера подряд по сменам, команды выходят подряд, порядок выхода по номерам", async () => {
    await api(app).post(`/competitions/${competitionId}/draw`, { mode: "random" }).expect(401);
    const view = (await admin.post(`/competitions/${competitionId}/draw`, { mode: "random", firstBib: 10 }).expect(201)).body;
    expect(view).toMatchObject({ started: false, last: { mode: "random" } });
    const people = await list();
    const first = people.filter((g) => g.shift === 1).sort((a, b) => a.bib - b.bib);
    const second = people.filter((g) => g.shift === 2).sort((a, b) => a.bib - b.bib);
    expect(first.map((g) => g.bib)).toEqual([10, 11, 12, 13, 14, 15, 16, 17]);
    expect(second.map((g) => g.bib)).toEqual([18, 19, 20]);
    expect(first.map((g) => g.startOrder)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // Участники одной команды получили соседние номера.
    for (const team of ["А", "Б"]) {
      const bibs = first.filter((g) => g.lastName.startsWith(team)).map((g) => g.bib);
      expect(Math.max(...bibs) - Math.min(...bibs)).toBe(2);
    }
    const rotation = (await api(app).get(`/competitions/${competitionId}/rotation`).expect(200)).body;
    expect(rotation.shifts[0].gymnastIds).toEqual(first.map((g) => g.id));
  });

  it("случайная действительно перемешивает", async () => {
    const orders = new Set<string>();
    for (let i = 0; i < 6; i++) {
      await admin.post(`/competitions/${competitionId}/draw`, { mode: "random", keepTeams: false }).expect(201);
      orders.add((await list()).sort((a, b) => a.bib - b.bib).map((g) => g.lastName).join(","));
    }
    expect(orders.size).toBeGreaterThan(1);
  });

  it("ручная: секретарь ставит номера, повторы не пропускает", async () => {
    const people = await list();
    const [a, b] = people.filter((g) => g.shift === 2);
    const clash = await admin
      .post(`/competitions/${competitionId}/draw`, { mode: "manual", bibs: [{ gymnastId: a!.id, bib: b!.bib }] })
      .expect(400);
    expect(clash.body.message).toContain(`№${b!.bib}`);
    // Обмен номерами двух участников — повтора в итоге нет.
    await admin
      .post(`/competitions/${competitionId}/draw`, {
        mode: "manual",
        bibs: [
          { gymnastId: a!.id, bib: b!.bib },
          { gymnastId: b!.id, bib: a!.bib },
        ],
      })
      .expect(201);
    const after = await list();
    expect(after.find((g) => g.id === a!.id)!.bib).toBe(b!.bib);
    expect(after.find((g) => g.id === b!.id)!.bib).toBe(a!.bib);
    // Порядок выхода в смене следует за номерами.
    expect(after.find((g) => g.id === a!.id)!.startOrder).toBe(b!.startOrder);
    expect((await admin.get(`/competitions/${competitionId}/draw`).expect(200)).body.last.mode).toBe("manual");
  });

  it("после первых оценок номера не меняются", async () => {
    const sv = (
      await admin
        .post(`/competitions/${competitionId}/judges`, { name: "СС", apparatus: "BB", role: "SUPERVISOR", seat: 1 })
        .expect(201)
    ).body.token as string;
    const [g] = await list();
    await api(app, sv).post(`/competitions/${competitionId}/performances`, { gymnastId: g!.id, apparatus: "BB" }).expect(201);
    expect((await admin.get(`/competitions/${competitionId}/draw`).expect(200)).body.started).toBe(true);
    const res = await admin.post(`/competitions/${competitionId}/draw`, { mode: "random" }).expect(409);
    expect(res.body.message).toContain("жеребьёвку не проводят");
  });
});
