import type { INestApplication } from "@nestjs/common";
import { LIVE_EVENTS, type AuditEntry, type PerformanceView, type RecoveryReport } from "@ag/shared";
import { io, type Socket } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, api, startApp } from "./helpers";

let app: INestApplication;
let url: string;
let admin: ReturnType<typeof api>;
let competitionId: string;
let gymnastIds: string[];
let tablet: string;
let journal: PerformanceView[];

const toRecord = (p: PerformanceView) => ({
  gymnastId: p.gymnastId,
  apparatus: p.apparatus,
  attempt: p.attempt,
  stage: p.stage,
  marks: p.marks.map((m) => ({ judgeId: m.judgeId, kind: m.kind, value: m.value })),
});
const bb = async () => (await admin.get(`/competitions/${competitionId}/performances?apparatus=BB`).expect(200)).body as PerformanceView[];

beforeAll(async () => {
  ({ app, url } = await startApp());
  admin = api(app, ADMIN_TOKEN);
  competitionId = (await admin.post("/competitions", { name: "Кубок после сбоя", discipline: "WAG" }).expect(201)).body.id;
  const rows = [
    { bib: 1, lastName: "Иванова", firstName: "Анна" },
    { bib: 2, lastName: "Петрова", firstName: "Мария" },
    { bib: 3, lastName: "Сидорова", firstName: "Ксения" },
  ];
  gymnastIds = (await admin.post(`/competitions/${competitionId}/gymnasts/import`, { rows }).expect(201)).body.map(
    (g: { id: string }) => g.id,
  );
  const judge = (name: string, apparatus: string, role: string, seat: number) =>
    admin.post(`/competitions/${competitionId}/judges`, { name, apparatus, role, seat, enterAllMarks: role === "SUPERVISOR" });
  tablet = (await judge("Кузнецова", "BB", "SUPERVISOR", 1).expect(201)).body.token;
  await judge("Орлова", "BB", "D", 1).expect(201);
  await judge("Смирнова", "BB", "E", 1).expect(201);
  await judge("Волкова", "BB", "E", 2).expect(201);
  // Планшет запомнил три утверждённых выступления.
  for (const [i, d] of [5.2, 4.8, 5].entries()) {
    await admin.post(`/competitions/${competitionId}/manual-scores`, { gymnastId: gymnastIds[i], apparatus: "BB", d, e: [1.2, 1.4] }).expect(201);
  }
  journal = await bb();
});

afterAll(async () => {
  await app?.close();
});

describe("оценки с планшетов после восстановления базы", () => {
  it("возвращает пропавшие выступления и не трогает те, что есть", async () => {
    // База «откатилась»: двух последних выступлений на сервере нет.
    for (const p of journal.slice(1)) await admin.delete(`/performances/${p.id}`).expect(200);
    expect(await bb()).toHaveLength(1);

    const report = (await api(app, tablet).post("/recovery", { performances: journal.map(toRecord) }).expect(201)).body as RecoveryReport;
    expect(report.restored.map((r) => r.total)).toEqual([13.5, 13.7]);
    expect(report.alreadyThere).toBe(1);
    expect(report.problems).toEqual([]);

    const now = await bb();
    expect(now.map((p) => [p.gymnastId, p.status, p.score?.total])).toEqual(
      journal.map((p) => [p.gymnastId, "APPROVED", p.score?.total]),
    );
    // Оценки снова за теми же судьями.
    expect(now[2]!.marks.map((m) => [m.judgeId, m.value])).toEqual(journal[2]!.marks.map((m) => [m.judgeId, m.value]));
    const audit = (await admin.get(`/competitions/${competitionId}/audit`).expect(200)).body as AuditEntry[];
    expect(audit.filter((a) => a.action === "marks.recovered_from_tablet")).toHaveLength(2);

    // Повторная отправка ничего не меняет.
    const again = (await api(app, tablet).post("/recovery", { performances: journal.map(toRecord) }).expect(201)).body;
    expect(again.restored).toEqual([]);
    expect(again.alreadyThere).toBe(3);
  });

  it("чужой снаряд пропускает, неизвестного судью и участника называет", async () => {
    const rec = toRecord(journal[0]!);
    const report = (
      await api(app, tablet)
        .post("/recovery", {
          performances: [
            { ...rec, apparatus: "FX" },
            { ...rec, gymnastId: "00000000-0000-4000-8000-000000000000" },
            { ...rec, attempt: 1, stage: "FINAL", marks: [{ judgeId: "00000000-0000-4000-8000-000000000001", kind: "D", value: 5 }] },
          ],
        })
        .expect(201)
    ).body as RecoveryReport;
    expect(report.restored).toEqual([]);
    expect(report.problems).toHaveLength(2);
    await admin.post("/recovery", { performances: [] }).expect(403);
  });

  it("секретариат просит планшеты на связи прислать оценки и видит итог", async () => {
    await admin.delete(`/performances/${(await bb())[1]!.id}`).expect(200);
    const socket: Socket = io(`${url}/live`, { transports: ["websocket"], auth: { token: tablet } });
    await new Promise<void>((resolve) => socket.on("connect", resolve));
    socket.on(LIVE_EVENTS.recoveryRequested, () => {
      void api(app, tablet).post("/recovery", { performances: journal.map(toRecord) }).then(() => undefined);
    });
    const report = (await admin.post(`/competitions/${competitionId}/recovery`).expect(201)).body as RecoveryReport;
    socket.close();
    expect(report.tabletsOnline).toBe(1);
    expect(report.tabletsAnswered).toBe(1);
    expect(report.restored).toHaveLength(1);
    expect(report.restored[0]!.gymnastId).toBe(gymnastIds[1]);
    expect(report.alreadyThere).toBe(2);
  });
});
