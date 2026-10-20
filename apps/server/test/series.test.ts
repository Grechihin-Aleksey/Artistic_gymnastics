import type { INestApplication } from "@nestjs/common";
import type { SeriesStandings } from "@ag/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, api, startApp } from "./helpers";

let app: INestApplication;
let admin: ReturnType<typeof api>;
const stages: string[] = [];

type Person = { lastName: string; firstName: string; birthDate?: string; club?: string };
const ANNA = { lastName: "Абрамова", firstName: "Анна", birthDate: "2012", club: "Олимп" };
const BELLA = { lastName: "Белова", firstName: "Бэлла", birthDate: "2013", club: "Старт" };
const VERA = { lastName: "Волкова", firstName: "Вера", club: "Олимп" };
const GALYA = { lastName: "Глебова", firstName: "Галя", club: "Юность" };

/** Этап: участники по порядку мест в многоборье (у каждого следующего оценки ниже). */
async function stage(name: string, category: string, ranking: Person[]): Promise<string> {
  const id = (await admin.post("/competitions", { name, discipline: "WAG" }).expect(201)).body.id as string;
  const rows = ranking.map((p, i) => ({ bib: i + 1, ...p, category }));
  const people = (await admin.post(`/competitions/${id}/gymnasts/import`, { rows }).expect(201)).body as { id: string }[];
  for (const apparatus of ["VT", "UB", "BB", "FX"]) {
    const sv = (
      await admin.post(`/competitions/${id}/judges`, { name: "СС", apparatus, role: "SUPERVISOR", seat: 1, enterAllMarks: true }).expect(201)
    ).body.token as string;
    for (const role of ["D", "E"]) await admin.post(`/competitions/${id}/judges`, { name: role, apparatus, role, seat: 1 }).expect(201);
    for (const [i, g] of people.entries()) {
      const perf = (await api(app, sv).post(`/competitions/${id}/performances`, { gymnastId: g.id, apparatus }).expect(201)).body;
      await api(app, sv).post(`/performances/${perf.id}/tablet-score`, { d: 5 - i * 0.5, e: [1] }).expect(201);
    }
  }
  return id;
}

beforeAll(async () => {
  ({ app } = await startApp());
  admin = api(app, ADMIN_TOKEN);
  stages.push(await stage("1 этап", "КМС", [ANNA, VERA, BELLA]));
  // На втором этапе дата рождения записана полностью — это тот же человек.
  stages.push(await stage("2 этап", "КМС", [BELLA, { ...ANNA, birthDate: "15.03.2012" }, GALYA]));
  stages.push(await stage("3 этап", "кмс", [VERA, BELLA]));
});

afterAll(async () => {
  await app?.close();
});

const table = (s: SeriesStandings) => s.categories[0]!.rows.map((r) => [r.rank, r.name, r.total, r.stages, r.dropped]);

describe("кубок из нескольких этапов", () => {
  let id: string;

  it("суммирует очки этапов, сопоставляя участников и разряды", async () => {
    await api(app).post("/series", { name: "Кубок области", points: [10, 8, 6], best: null, stages }).expect(401);
    expect((await admin.post("/series", { name: "Кубок", points: [], best: null, stages: [] }).expect(400)).body.issues[0].path).toBe("points");
    await admin.post("/series", { name: "Кубок", points: [10], best: null, stages: ["00000000-0000-4000-8000-000000000000"] }).expect(400);
    id = (await admin.post("/series", { name: "Кубок области", points: [10, 8, 6], best: null, stages }).expect(201)).body.id;

    const standings = (await api(app).get(`/series/${id}/standings`).expect(200)).body as SeriesStandings;
    expect(standings.stages.map((s) => s.name)).toEqual(["1 этап", "2 этап", "3 этап"]);
    expect(standings.categories.map((c) => c.name)).toEqual(["КМС"]);
    expect(table(standings)).toEqual([
      [1, "Белова Бэлла", 24, [6, 10, 8], []],
      [2, "Абрамова Анна", 18, [10, 8, null], []],
      [2, "Волкова Вера", 18, [8, null, 10], []],
      [4, "Глебова Галя", 6, [null, 6, null], []],
    ]);
    expect(standings.categories[0]!.rows[1]).toMatchObject({ club: "Олимп", birthYear: "2012", places: [1, 1, 0] });
  });

  it("считает только лучшие этапы, а при равенстве — по числу мест", async () => {
    await admin.put(`/series/${id}`, { name: "Кубок области", points: [10, 8, 6], best: 2, stages }).expect(200);
    const standings = (await api(app).get(`/series/${id}/standings`).expect(200)).body as SeriesStandings;
    // У всех троих по 18; у Беловой есть ещё 3-е место.
    expect(table(standings)).toEqual([
      [1, "Белова Бэлла", 18, [6, 10, 8], [0]],
      [2, "Абрамова Анна", 18, [10, 8, null], []],
      [2, "Волкова Вера", 18, [8, null, 10], []],
      [4, "Глебова Галя", 6, [null, 6, null], []],
    ]);
    const pdf = await admin.get(`/series/${id}/protocol`).expect(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");
    expect((await api(app).get("/series").expect(200)).body).toEqual([expect.objectContaining({ id, name: "Кубок области", best: 2 })]);
  });

  it("удалённый этап просто выпадает, кубок можно удалить", async () => {
    await admin.delete(`/competitions/${stages[2]}`).expect(204);
    const standings = (await api(app).get(`/series/${id}/standings`).expect(200)).body as SeriesStandings;
    expect(standings.stages.map((s) => s.name)).toEqual(["1 этап", "2 этап"]);
    await admin.delete(`/series/${id}`).expect(200);
    await api(app).get(`/series/${id}/standings`).expect(404);
  });
});
