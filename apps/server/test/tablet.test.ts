import type { INestApplication } from "@nestjs/common";
import type { PerformanceView } from "@ag/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, api, startApp } from "./helpers";

let app: INestApplication;
let admin: ReturnType<typeof api>;
let competitionId: string;
let gymnastIds: string[];
let tablet: string;

beforeAll(async () => {
  ({ app } = await startApp());
  admin = api(app, ADMIN_TOKEN);
  competitionId = (await admin.post("/competitions", { name: "Школьный кубок", discipline: "WAG" }).expect(201)).body.id;
  const rows = [
    { bib: 1, lastName: "Иванова", firstName: "Анна" },
    { bib: 2, lastName: "Петрова", firstName: "Мария" },
  ];
  gymnastIds = (await admin.post(`/competitions/${competitionId}/gymnasts/import`, { rows }).expect(201)).body.map(
    (g: { id: string }) => g.id,
  );
  const judge = (name: string, role: string, seat: number, enterAllMarks = false) =>
    admin.post(`/competitions/${competitionId}/judges`, { name, apparatus: "BB", role, seat, enterAllMarks });
  // Флажок «один планшет» у судьи E ничего не значит: судья заводится обычным, без планшета снаряда.
  const e = (await judge("Смирнова", "E", 1, true).expect(201)).body;
  expect(e.enterAllMarks).toBe(false);
  await admin.delete(`/judges/${e.id}`).expect(200);
  tablet = (await judge("Кузнецова", "SUPERVISOR", 1, true).expect(201)).body.token;
});

afterAll(async () => {
  await app?.close();
});

const call = async (i: number) =>
  (
    await api(app, tablet)
      .post(`/competitions/${competitionId}/performances`, { gymnastId: gymnastIds[i], apparatus: "BB" })
      .expect(201)
  ).body as PerformanceView;

describe("один планшет на снаряд", () => {
  let perfId: string;

  it("требует завести судей бригады — они идут в протокол", async () => {
    perfId = (await call(0)).id;
    const res = await api(app, tablet).post(`/performances/${perfId}/tablet-score`, { d: 4.5, e: [1.2] }).expect(409);
    expect(res.body.message).toContain("Заведите судей");
    const judge = (name: string, role: string, seat: number) =>
      admin.post(`/competitions/${competitionId}/judges`, { name, apparatus: "BB", role, seat }).expect(201);
    await judge("Орлова", "D", 1);
    for (const [seat, name] of ["Волкова", "Зайцева", "Попова"].entries()) await judge(name, "E", seat + 1);
  });

  it("планшет видит бригаду и записывает оценки за судьями", async () => {
    const me = (await api(app, tablet).get("/me").expect(200)).body;
    expect(me.judge.enterAllMarks).toBe(true);
    expect(me.panel.filter((j: { role: string }) => j.role === "E").map((j: { name: string }) => j.name)).toEqual([
      "Волкова",
      "Зайцева",
      "Попова",
    ]);
    await api(app, tablet).post(`/performances/${perfId}/tablet-score`, { d: 4.5, e: [1.2, 1.4] }).expect(400);
    const approved = (
      await api(app, tablet)
        .post(`/performances/${perfId}/tablet-score`, { d: 4.5, e: [1.2, 1.4, 1.0], neutral: 0.1 })
        .expect(201)
    ).body as PerformanceView;
    expect(approved.status).toBe("APPROVED");
    // 3 судьи E — ничего не отбрасывается: E = 10 − 1.2 = 8.8.
    expect(approved.score).toEqual({ d: 4.5, e: 8.8, neutral: 0.1, total: 13.2 });
    expect(approved.marks.map((m) => [m.role, m.seat, m.kind, m.value])).toEqual(
      expect.arrayContaining([
        ["D", 1, "D", 4.5],
        ["E", 1, "E", 1.2],
        ["E", 2, "E", 1.4],
        ["E", 3, "E", 1.0],
        ["SUPERVISOR", 1, "NEUTRAL", 0.1],
      ]),
    );
    await api(app, tablet).post(`/performances/${perfId}/tablet-score`, { d: 4.5, e: [1, 1, 1] }).expect(409);
  });

  it("обычный старший судья не может вводить оценки за бригаду", async () => {
    const other = (
      await admin
        .post(`/competitions/${competitionId}/judges`, { name: "Лебедева", apparatus: "UB", role: "SUPERVISOR", seat: 1 })
        .expect(201)
    ).body.token;
    const perf = await call(1);
    await api(app, other).post(`/performances/${perf.id}/tablet-score`, { d: 4, e: [1, 1, 1] }).expect(403);
  });
});
