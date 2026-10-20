import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, api, startApp } from "./helpers";

let app: INestApplication;
let admin: ReturnType<typeof api>;
let id: string;
let other: string;
let supervisor: string;

beforeAll(async () => {
  ({ app } = await startApp());
  admin = api(app, ADMIN_TOKEN);
  id = (await admin.post("/competitions", { name: "Первенство города", discipline: "WAG" }).expect(201)).body.id;
  other = (await admin.post("/competitions", { name: "Кубок клуба", discipline: "WAG" }).expect(201)).body.id;
  const rows = [
    { bib: 1, lastName: "Абрамова", firstName: "Анна", club: "Олимп", category: "КМС" },
    { bib: 2, lastName: "Белова", firstName: "Бэлла", club: "Старт", category: "КМС" },
  ];
  const people = (await admin.post(`/competitions/${id}/gymnasts/import`, { rows }).expect(201)).body as { id: string }[];
  supervisor = (
    await admin.post(`/competitions/${id}/judges`, { name: "СС", apparatus: "FX", role: "SUPERVISOR", seat: 1, enterAllMarks: true }).expect(201)
  ).body.token;
  for (const role of ["D", "E"]) await admin.post(`/competitions/${id}/judges`, { name: role, apparatus: "FX", role, seat: 1 }).expect(201);
  for (const [i, g] of people.entries()) {
    const perf = (await api(app, supervisor).post(`/competitions/${id}/performances`, { gymnastId: g.id, apparatus: "FX" }).expect(201)).body;
    await api(app, supervisor).post(`/performances/${perf.id}/tablet-score`, { d: 5 - i, e: [1] }).expect(201);
  }
  await admin.post("/series", { name: "Кубок области", points: [10, 8], best: null, stages: [id, other] }).expect(201);
});

afterAll(async () => {
  await app?.close();
});

describe("перенос турнира на другой компьютер", () => {
  let file: Record<string, unknown>;
  let results: unknown;
  let gymnasts: unknown;

  it("выгружает турнир одним файлом только для секретариата", async () => {
    await api(app).get(`/competitions/${id}/export`).expect(401);
    await api(app, supervisor).get(`/competitions/${id}/export`).expect(403);
    const res = await admin.get(`/competitions/${id}/export`).expect(200);
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="competition-\d{4}-\d{2}-\d{2}\.json"$/);
    file = JSON.parse(res.text) as Record<string, unknown>;
    expect(file).toMatchObject({ format: "ag-competition", version: 1 });
    const data = file.data as Record<string, unknown[]>;
    expect(data.gymnasts).toHaveLength(2);
    expect(data.judges).toHaveLength(3);
    expect(data.performances).toHaveLength(2);
    expect(data.marks!.length).toBeGreaterThan(0);
    results = (await api(app).get(`/competitions/${id}/results/all-around`).expect(200)).body;
    gymnasts = (await admin.get(`/competitions/${id}/gymnasts`).expect(200)).body;
  });

  it("не загружает турнир, который уже есть", async () => {
    const res = await admin.post("/competitions/import", file).expect(409);
    expect(res.body.message).toBe("Турнир «Первенство города» уже есть на этом компьютере. Чтобы загрузить его из файла заново, сначала удалите его");
  });

  it("удаляет турнир целиком и убирает его из кубков", async () => {
    await api(app, supervisor).delete(`/competitions/${id}`).expect(403);
    await admin.delete(`/competitions/${id}`).expect(204);
    await admin.delete(`/competitions/${id}`).expect(404);
    await admin.get(`/competitions/${id}`).expect(404);
    await api(app, supervisor).get("/me").expect(401);
    const [cup] = (await api(app).get("/series").expect(200)).body as { stages: string[] }[];
    expect(cup!.stages).toEqual([other]);
    await admin.get(`/competitions/${other}`).expect(200);
  });

  it("отклоняет чужой и повреждённый файл", async () => {
    expect((await admin.post("/competitions/import", { hello: "world" }).expect(400)).body.message).toBe("Это не файл турнира");
    const broken = { ...file, data: { ...(file.data as object), marks: "нет" } };
    expect((await admin.post("/competitions/import", broken).expect(400)).body.message).toBe("Файл повреждён или это не файл турнира");
    const newer = { ...file, schema: "9999_future" };
    expect((await admin.post("/competitions/import", newer).expect(422)).body.message).toMatch(/более новой версии/);
    await api(app).post("/competitions/import", file).expect(401);
  });

  it("загружает турнир из файла: результаты те же, QR-коды судей действуют", async () => {
    expect((await admin.post("/competitions/import", file).expect(201)).body).toEqual({ id, name: "Первенство города" });
    expect((await api(app).get(`/competitions/${id}/results/all-around`).expect(200)).body).toEqual(results);
    expect((await admin.get(`/competitions/${id}/gymnasts`).expect(200)).body).toEqual(gymnasts);
    expect((await api(app, supervisor).get("/me").expect(200)).body.judge.competitionId).toBe(id);
    const audit = (await admin.get(`/competitions/${id}/audit`).expect(200)).body as { text: string }[];
    expect(audit[0]!.text).toMatch(/^Турнир загружен из файла, выгруженного /);
    // Выгрузка после загрузки — тот же турнир.
    const again = JSON.parse((await admin.get(`/competitions/${id}/export`).expect(200)).text) as { data: Record<string, unknown[]> };
    const before = file.data as Record<string, unknown[]>;
    for (const table of ["competitions", "gymnasts", "judges", "performances", "marks"]) expect(again.data[table]).toEqual(before[table]);
  });
});
