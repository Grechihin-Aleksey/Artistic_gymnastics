import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import type { BoardSnapshot, RotationView } from "@ag/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, api, startApp } from "./helpers";

let app: INestApplication;
let admin: ReturnType<typeof api>;
let competitionId: string;
const ids = new Map<number, string>();
const panel = { d: "", e: "", sv: "" };

beforeAll(async () => {
  ({ app } = await startApp());
  admin = api(app, ADMIN_TOKEN);
  competitionId = (
    await admin
      .post("/competitions", {
        name: "Первенство школ",
        discipline: "MAG",
        teamFormat: { roster: 2, perApparatus: 2, counting: 2 },
      })
      .expect(201)
  ).body.id;
  // Одноимённая команда в двух разрядах — это две разные команды.
  const rows = [
    { bib: 1, lastName: "Иванов", firstName: "Пётр", team: "Школа 5", category: "1 юношеский", shift: 1 },
    { bib: 2, lastName: "Петров", firstName: "Иван", team: "Школа 5", category: "1 юношеский", shift: 1 },
    { bib: 3, lastName: "Сидоров", firstName: "Олег", category: "1 юношеский", shift: 1 },
    { bib: 4, lastName: "Козлов", firstName: "Ян", team: "Школа 5", category: "2 юношеский", shift: 2 },
    { bib: 5, lastName: "Орлов", firstName: "Лев", team: "Школа 5", category: "2 юношеский", shift: 2 },
  ];
  const created = (await admin.post(`/competitions/${competitionId}/gymnasts/import`, { rows }).expect(201)).body as {
    id: string;
    bib: number;
  }[];
  for (const g of created) ids.set(g.bib, g.id);
  const judge = async (role: string) =>
    (await admin.post(`/competitions/${competitionId}/judges`, { name: role, apparatus: "HB", role, seat: 1 }).expect(201))
      .body.token as string;
  panel.d = await judge("D");
  panel.e = await judge("E");
  panel.sv = await judge("SUPERVISOR");
});

afterAll(async () => {
  await app?.close();
});

async function perform(bib: number, d: number) {
  const perf = (
    await api(app, panel.sv)
      .post(`/competitions/${competitionId}/performances`, { gymnastId: ids.get(bib), apparatus: "HB" })
      .expect(201)
  ).body;
  await api(app, panel.d).post("/marks", { id: randomUUID(), performanceId: perf.id, kind: "D", value: d }).expect(201);
  await api(app, panel.e).post("/marks", { id: randomUUID(), performanceId: perf.id, kind: "E", value: 1 }).expect(201);
  await api(app, panel.sv).post(`/performances/${perf.id}/approve`).expect(201);
}

describe("разряды", () => {
  it("создаются из списка, команды считаются внутри разряда", async () => {
    const categories = (await api(app).get(`/competitions/${competitionId}/categories`).expect(200)).body;
    expect(categories.map((c: { name: string }) => c.name)).toEqual(["1 юношеский", "2 юношеский"]);
    const teams = (await api(app).get(`/competitions/${competitionId}/teams`).expect(200)).body;
    expect(teams).toHaveLength(2);
    expect(new Set(teams.map((t: { categoryId: string }) => t.categoryId)).size).toBe(2);
  });

  it("места считаются отдельно в каждом разряде", async () => {
    await perform(1, 3);
    await perform(4, 4);
    await perform(2, 5);
    const [first, second] = (await api(app).get(`/competitions/${competitionId}/categories`).expect(200)).body as {
      id: string;
    }[];
    const hb1 = (await api(app).get(`/competitions/${competitionId}/results/apparatus/HB?category=${first!.id}`).expect(200))
      .body;
    expect(hb1.map((r: { rank: number; gymnast: { bib: number } }) => [r.rank, r.gymnast.bib])).toEqual([
      [1, 2],
      [2, 1],
    ]);
    const snapshot = (await api(app).get(`/competitions/${competitionId}/results/snapshot`).expect(200))
      .body as BoardSnapshot;
    expect(snapshot.categories.map((c) => c.name)).toEqual(["1 юношеский", "2 юношеский"]);
    expect(snapshot.categories[1]!.id).toBe(second!.id);
    expect(snapshot.categories[1]!.apparatus.HB!.map((r) => [r.rank, r.gymnast.bib])).toEqual([[1, 4]]);
    expect(snapshot.categories[0]!.allAround.map((r) => r.gymnast.bib)).toEqual([2, 1]);
    expect(snapshot.categories[0]!.teams).toHaveLength(1);
    expect(snapshot.categories[1]!.teams[0]!.total).toBe(13);
  });

  it("протокол собирается для одного разряда", async () => {
    const [first] = (await api(app).get(`/competitions/${competitionId}/categories`).expect(200)).body as { id: string }[];
    const res = await admin.get(`/competitions/${competitionId}/protocols/all-around?category=${first!.id}`).expect(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    await admin.get(`/competitions/${competitionId}/protocols/teams?category=nope`).expect(400);
  });
});

describe("смены и ротации", () => {
  it("смены получают стартовые снаряды по очереди и порядок из списка", async () => {
    const view = (await api(app).get(`/competitions/${competitionId}/rotation`).expect(200)).body as RotationView;
    expect(view.rotation).toBe(0);
    expect(view.rotations).toBe(6);
    expect(view.shifts.map((s) => [s.number, s.apparatus])).toEqual([
      [1, "FX"],
      [2, "PH"],
    ]);
    expect(view.shifts[0]!.gymnastIds).toEqual([ids.get(1), ids.get(2), ids.get(3)]);
  });

  it("секретариат меняет стартовый снаряд и переводит ротацию", async () => {
    await api(app).post(`/competitions/${competitionId}/rotation`, { rotation: 1 }).expect(401);
    await admin.put(`/competitions/${competitionId}/shifts/2`, { startApparatus: "UB" }).expect(400);
    await admin.put(`/competitions/${competitionId}/shifts/9`, { startApparatus: "HB" }).expect(404);
    await admin.put(`/competitions/${competitionId}/shifts/1`, { startApparatus: "HB" }).expect(200);
    const view = (await admin.post(`/competitions/${competitionId}/rotation`, { rotation: 1 }).expect(201))
      .body as RotationView;
    expect(view.shifts.map((s) => [s.number, s.apparatus])).toEqual([
      [1, "FX"],
      [2, "SR"],
    ]);
    // После ротации первый в смене уходит в конец.
    expect(view.shifts[0]!.gymnastIds).toEqual([ids.get(2), ids.get(3), ids.get(1)]);
    await admin.post(`/competitions/${competitionId}/rotation`, { rotation: 6 }).expect(400);
  });

  it("дозагрузка продолжает порядок в смене", async () => {
    const [extra] = (
      await admin
        .post(`/competitions/${competitionId}/gymnasts/import`, {
          rows: [{ bib: 6, lastName: "Волков", firstName: "Егор", category: "1 юношеский", shift: 1 }],
        })
        .expect(201)
    ).body;
    expect(extra.startOrder).toBe(4);
  });
});
