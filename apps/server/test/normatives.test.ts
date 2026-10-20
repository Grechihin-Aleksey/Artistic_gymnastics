import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, api, startApp } from "./helpers";

let app: INestApplication;
let admin: ReturnType<typeof api>;
let competitionId: string;
let categoryId: string;
const ids = new Map<number, string>();

beforeAll(async () => {
  ({ app } = await startApp());
  admin = api(app, ADMIN_TOKEN);
  competitionId = (await admin.post("/competitions", { name: "Первенство района", discipline: "WAG" }).expect(201)).body.id;
  const rows = [
    { bib: 1, lastName: "Орлова", firstName: "Лиза", category: "2 юношеский" },
    { bib: 2, lastName: "Кимова", firstName: "Юля", category: "2 юношеский" },
    { bib: 3, lastName: "Зуева", firstName: "Зоя", category: "2 юношеский" },
  ];
  for (const g of (await admin.post(`/competitions/${competitionId}/gymnasts/import`, { rows }).expect(201)).body) {
    ids.set(g.bib, g.id);
  }
  categoryId = (await api(app).get(`/competitions/${competitionId}/categories`).expect(200)).body[0].id;
  // Орлова: 4 × 13 = 52, Кимова: 4 × 12 = 48, Зуева выступила не на всех снарядах.
  const d: Record<number, number> = { 1: 4, 2: 3, 3: 5 };
  for (const apparatus of ["VT", "UB", "BB", "FX"]) {
    const token = (
      await admin
        .post(`/competitions/${competitionId}/judges`, { name: "СС", apparatus, role: "SUPERVISOR", seat: 1, enterAllMarks: true })
        .expect(201)
    ).body.token as string;
    for (const role of ["D", "E"]) {
      await admin.post(`/competitions/${competitionId}/judges`, { name: role, apparatus, role, seat: 1 }).expect(201);
    }
    const tablet = api(app, token);
    for (const bib of apparatus === "FX" ? [1, 2] : [1, 2, 3]) {
      const perf = (
        await tablet.post(`/competitions/${competitionId}/performances`, { gymnastId: ids.get(bib), apparatus }).expect(201)
      ).body;
      await tablet.post(`/performances/${perf.id}/tablet-score`, { d: d[bib], e: [1] }).expect(201);
    }
  }
});

afterAll(async () => {
  await app?.close();
});

const path = () => `/competitions/${competitionId}/normatives`;

describe("нормативы разрядов", () => {
  it("сохраняет уровни от высшего к низшему", async () => {
    const body = {
      categories: [
        {
          categoryId,
          levels: [
            { name: "2 юношеский", min: 45 },
            { name: "1 юношеский", min: 50 },
          ],
        },
      ],
    };
    await api(app).put(path(), body).expect(401);
    const saved = (await admin.put(path(), body).expect(200)).body;
    expect(saved.categories[0]).toMatchObject({
      name: "2 юношеский",
      levels: [
        { name: "1 юношеский", min: 50 },
        { name: "2 юношеский", min: 45 },
      ],
    });
    await admin
      .put(path(), { categories: [{ categoryId, levels: [{ name: "КМС", min: 50 }, { name: "кмс", min: 40 }] }] })
      .expect(400);
    await admin
      .put(path(), { categories: [{ categoryId: "00000000-0000-4000-8000-000000000000", levels: [] }] })
      .expect(400);
  });

  it("отмечает выполнивших: высший набранный уровень, только за всё многоборье", async () => {
    const rows = (await api(app).get(`/competitions/${competitionId}/results/all-around`).expect(200)).body;
    const earned = Object.fromEntries(rows.map((r: { gymnast: { bib: number }; earned: string | null }) => [r.gymnast.bib, r.earned]));
    expect(earned).toEqual({ 1: "1 юношеский", 2: "2 юношеский", 3: null });

    // Норматив подняли — пересчиталось сразу.
    await admin.put(path(), { categories: [{ categoryId, levels: [{ name: "1 юношеский", min: 52.001 }] }] }).expect(200);
    const again = (await api(app).get(`/competitions/${competitionId}/results/all-around`).expect(200)).body;
    expect(again.every((r: { earned: string | null }) => r.earned === null)).toBe(true);
    await admin.put(path(), { categories: [{ categoryId, levels: [{ name: "1 юношеский", min: 50 }, { name: "2 юношеский", min: 45 }] }] }).expect(200);
  });

  it("печатает список выполнивших и столбец в протоколе многоборья", async () => {
    for (const p of ["earned", "all-around"]) {
      const res = await admin.get(`/competitions/${competitionId}/protocols/${p}`).expect(200);
      expect(res.headers["content-type"]).toContain("application/pdf");
    }
    await api(app).get(`/competitions/${competitionId}/protocols/earned`).expect(401);
  });
});

describe("судейская коллегия, нагрудные номера и итоговый отчёт", () => {
  it("сохраняет главного судью и секретаря, категорию судьи", async () => {
    const officials = {
      chiefJudge: { name: "Смирнова О. В.", category: "ВК", city: "Тверь" },
      chiefSecretary: { name: "Петров И. И.", category: "1К" },
    };
    await api(app).put(`/competitions/${competitionId}/officials`, officials).expect(401);
    const saved = (await admin.put(`/competitions/${competitionId}/officials`, officials).expect(200)).body;
    expect(saved.officials).toEqual(officials);
    await admin.put(`/competitions/${competitionId}/officials`, { chiefJudge: { name: "" }, chiefSecretary: null }).expect(400);

    const judge = (
      await admin
        .post(`/competitions/${competitionId}/judges`, { name: "Козлова А. А.", category: "2К", apparatus: "BB", role: "E", seat: 2 })
        .expect(201)
    ).body;
    expect(judge.category).toBe("2К");
  });

  it("печатает коллегию, номера и отчёт", async () => {
    for (const p of ["officials", "bibs", "report", "apparatus/BB", "diplomas"]) {
      const res = await admin.get(`/competitions/${competitionId}/protocols/${p}`).expect(200);
      expect(res.headers["content-type"]).toContain("application/pdf");
    }
    await api(app).get(`/competitions/${competitionId}/protocols/report`).expect(401);
  });
});
