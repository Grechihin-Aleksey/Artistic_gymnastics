import type { INestApplication } from "@nestjs/common";
import type { AuditEntry, BoardSnapshot, PerformanceView } from "@ag/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, api, startApp } from "./helpers";

let app: INestApplication;
let admin: ReturnType<typeof api>;
let competitionId: string;
let gymnastIds: [string, string, string];
let tablet: string;

beforeAll(async () => {
  ({ app } = await startApp());
  admin = api(app, ADMIN_TOKEN);
  competitionId = (await admin.post("/competitions", { name: "Кубок без связи", discipline: "WAG" }).expect(201)).body.id;
  const rows = [
    { bib: 1, lastName: "Иванова", firstName: "Анна" },
    { bib: 2, lastName: "Петрова", firstName: "Мария" },
    { bib: 3, lastName: "Сидорова", firstName: "Ксения" },
  ];
  gymnastIds = (await admin.post(`/competitions/${competitionId}/gymnasts/import`, { rows }).expect(201)).body.map(
    (g: { id: string }) => g.id,
  );
  const judge = (name: string, role: string, seat: number) =>
    admin.post(`/competitions/${competitionId}/judges`, { name, apparatus: "BB", role, seat, enterAllMarks: role === "SUPERVISOR" });
  tablet = (await judge("Кузнецова", "SUPERVISOR", 1).expect(201)).body.token;
  await judge("Орлова", "D", 1).expect(201);
  await judge("Смирнова", "E", 1).expect(201);
  await judge("Волкова", "E", 2).expect(201);
});

afterAll(async () => {
  await app?.close();
});

const manual = (body: Record<string, unknown>) => admin.post(`/competitions/${competitionId}/manual-scores`, body);
const bbOf = async (gymnastId: string) =>
  (await admin.get(`/competitions/${competitionId}/performances?apparatus=BB`).expect(200)).body.find(
    (p: PerformanceView) => p.gymnastId === gymnastId,
  ) as PerformanceView | undefined;

describe("оценки с судейских листов", () => {
  it("секретариат вводит оценку, которой не было: выступление сразу утверждено", async () => {
    const view = (await manual({ gymnastId: gymnastIds[0], apparatus: "BB", d: 5.2, e: [1.2, 1.4], neutral: 0.1 }).expect(201))
      .body as PerformanceView;
    expect(view.status).toBe("APPROVED");
    expect(view.score).toEqual({ d: 5.2, e: 8.7, neutral: 0.1, total: 13.8 });
    // Оценки записаны за судьями бригады, как с планшета.
    expect(view.marks.filter((m) => m.kind === "E").map((m) => m.value)).toEqual([1.2, 1.4]);
    const snap = (await api(app).get(`/competitions/${competitionId}/results/snapshot`).expect(200)).body as BoardSnapshot;
    expect(snap.categories[0]!.apparatus.BB?.[0]?.score.total).toBe(13.8);
  });

  it("исправляет утверждённую оценку и проверяет число сбавок E", async () => {
    await manual({ gymnastId: gymnastIds[0], apparatus: "BB", d: 5.2, e: [1] }).expect(400);
    const view = (await manual({ gymnastId: gymnastIds[0], apparatus: "BB", d: 5.4, e: [1.2, 1.4] }).expect(201)).body;
    expect(view.score.total).toBe(14.1);
    expect(view.marks.some((m: { kind: string }) => m.kind === "NEUTRAL")).toBe(false);
  });

  it("закрывает выступление, которое судьи начали на планшете до потери связи", async () => {
    const called = (
      await api(app, tablet).post(`/competitions/${competitionId}/performances`, { gymnastId: gymnastIds[1], apparatus: "BB" }).expect(201)
    ).body as PerformanceView;
    const view = (await manual({ gymnastId: gymnastIds[1], apparatus: "BB", d: 4, e: [2, 2] }).expect(201)).body;
    expect(view.id).toBe(called.id);
    expect(view.score.total).toBe(12);
    // Снаряд свободен: старший судья вызывает следующую.
    await api(app, tablet).post(`/competitions/${competitionId}/performances`, { gymnastId: gymnastIds[2], apparatus: "BB" }).expect(201);
  });

  it("без судей снаряда и в чужой программе не вводится", async () => {
    await manual({ gymnastId: gymnastIds[0], apparatus: "FX", d: 5, e: [1] }).expect(409);
    await manual({ gymnastId: gymnastIds[0], apparatus: "PH", d: 5, e: [1] }).expect(400);
    await api(app, tablet).post(`/competitions/${competitionId}/manual-scores`, { gymnastId: gymnastIds[0], apparatus: "BB", d: 5, e: [1, 1] }).expect(403);
  });

  it("удаление убирает выступление из результатов, журнал помнит снаряд и участника", async () => {
    const perf = (await bbOf(gymnastIds[0]))!;
    await api(app, tablet).delete(`/performances/${perf.id}`).expect(403);
    await admin.delete(`/performances/${perf.id}`).expect(200);
    await admin.delete(`/performances/${perf.id}`).expect(404);
    expect(await bbOf(gymnastIds[0])).toBeUndefined();
    const snap = (await api(app).get(`/competitions/${competitionId}/results/snapshot`).expect(200)).body as BoardSnapshot;
    expect(snap.categories[0]!.apparatus.BB?.some((r) => r.gymnast.id === gymnastIds[0])).toBe(false);

    const audit = (await admin.get(`/competitions/${competitionId}/audit?group=marks`).expect(200)).body as AuditEntry[];
    const mine = audit.filter((e) => e.gymnast === "№1 Иванова Анна");
    expect(mine[0]!.text).toBe("Выступление удалено вместе с оценками, итог был 14.100");
    expect(mine.every((e) => e.apparatus === "BB")).toBe(true);
    expect(mine.some((e) => e.text.startsWith("Оценки введены секретариатом с судейского листа"))).toBe(true);
    expect(mine.some((e) => e.text.endsWith("прежний итог 13.800"))).toBe(true);

    // После удаления оценку можно ввести заново.
    await manual({ gymnastId: gymnastIds[0], apparatus: "BB", d: 5, e: [1, 1] }).expect(201);
  });
});
