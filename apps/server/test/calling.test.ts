import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, api, startApp } from "./helpers";

let app: INestApplication;
let admin: ReturnType<typeof api>;
let competitionId: string;

beforeAll(async () => {
  ({ app } = await startApp());
  admin = api(app, ADMIN_TOKEN);
  competitionId = (await admin.post("/competitions", { name: "Кубок", discipline: "WAG" }).expect(201)).body.id;
});

afterAll(async () => {
  await app?.close();
});

describe("список участников", () => {
  it("загружается целиком, команды создаются по названию", async () => {
    await admin.post(`/competitions/${competitionId}/teams`, { name: "СШОР №1" }).expect(201);
    const rows = [
      { bib: 1, lastName: "Иванова", firstName: "Анна", club: "Тверь", team: "СШОР №1" },
      { bib: 2, lastName: "Петрова", firstName: "Мария", team: "Олимп" },
      { bib: 3, lastName: "Сидорова", firstName: "Вера" },
    ];
    const created = (await admin.post(`/competitions/${competitionId}/gymnasts/import`, { rows }).expect(201)).body;
    expect(created).toHaveLength(3);
    const teams = (await api(app).get(`/competitions/${competitionId}/teams`).expect(200)).body as { id: string; name: string }[];
    expect(teams.map((t) => t.name)).toEqual(["Олимп", "СШОР №1"]);
    const people = (await api(app).get(`/competitions/${competitionId}/gymnasts`).expect(200)).body;
    expect(people[0]).toMatchObject({ bib: 1, club: "Тверь", teamId: teams[1]!.id });
    expect(people[2].teamId).toBeNull();
  });

  it("не принимает повторы номеров и ничего не добавляет при ошибке", async () => {
    const dup = await admin
      .post(`/competitions/${competitionId}/gymnasts/import`, {
        rows: [
          { bib: 7, lastName: "А", firstName: "Б" },
          { bib: 7, lastName: "В", firstName: "Г" },
        ],
      })
      .expect(400);
    expect(dup.body.message).toContain("7");
    const taken = await admin
      .post(`/competitions/${competitionId}/gymnasts/import`, {
        rows: [
          { bib: 8, lastName: "А", firstName: "Б", team: "Новая" },
          { bib: 2, lastName: "В", firstName: "Г" },
        ],
      })
      .expect(400);
    expect(taken.body.message).toContain("2");
    const people = (await api(app).get(`/competitions/${competitionId}/gymnasts`).expect(200)).body;
    expect(people).toHaveLength(3);
    const teams = (await api(app).get(`/competitions/${competitionId}/teams`).expect(200)).body;
    expect(teams).toHaveLength(2);
  });
});

describe("вызов участника", () => {
  it("старший судья вызывает на свой снаряд, следующего — только после утверждения", async () => {
    const judge = async (apparatus: string, role: string) =>
      (await admin.post(`/competitions/${competitionId}/judges`, { name: role, apparatus, role, seat: 1 }).expect(201)).body
        .token as string;
    const sv = await judge("BB", "SUPERVISOR");
    const d = await judge("BB", "D");
    const e = await judge("BB", "E");
    const people = (await api(app).get(`/competitions/${competitionId}/gymnasts`).expect(200)).body as { id: string }[];

    await api(app, d).post(`/competitions/${competitionId}/performances`, { gymnastId: people[0]!.id, apparatus: "BB" }).expect(403);
    await api(app, sv).post(`/competitions/${competitionId}/performances`, { gymnastId: people[0]!.id, apparatus: "FX" }).expect(403);
    const perf = (
      await api(app, sv).post(`/competitions/${competitionId}/performances`, { gymnastId: people[0]!.id, apparatus: "BB" }).expect(201)
    ).body;
    const busy = await api(app, sv)
      .post(`/competitions/${competitionId}/performances`, { gymnastId: people[1]!.id, apparatus: "BB" })
      .expect(409);
    expect(busy.body.message).toContain("не утверждена");

    await api(app, d).post("/marks", { id: randomUUID(), performanceId: perf.id, kind: "D", value: 5 }).expect(201);
    await api(app, e).post("/marks", { id: randomUUID(), performanceId: perf.id, kind: "E", value: 1 }).expect(201);
    await api(app, sv).post(`/performances/${perf.id}/approve`).expect(201);
    await api(app, sv).post(`/competitions/${competitionId}/performances`, { gymnastId: people[1]!.id, apparatus: "BB" }).expect(201);
  });
});
