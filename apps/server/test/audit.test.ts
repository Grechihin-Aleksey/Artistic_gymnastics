import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import type { AuditEntry } from "@ag/shared";
import ExcelJS from "exceljs";
import type request from "supertest";
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
  competitionId = (await admin.post("/competitions", { name: "Кубок города", discipline: "WAG" }).expect(201)).body.id;
  const rows = [
    { bib: 1, lastName: "Абрамова", firstName: "Анна", club: "Олимп" },
    { bib: 2, lastName: "Белова", firstName: "Бэлла", club: "Старт" },
  ];
  for (const g of (await admin.post(`/competitions/${competitionId}/gymnasts/import`, { rows }).expect(201)).body) {
    ids.set(g.bib, g.id);
  }
  const judge = async (role: string, name: string) =>
    (await admin.post(`/competitions/${competitionId}/judges`, { name, apparatus: "BB", role, seat: 1 }).expect(201)).body
      .token as string;
  panel.sv = await judge("SUPERVISOR", "Смирнова О. В.");
  panel.d = await judge("D", "Петрова И. И.");
  panel.e = await judge("E", "Козлова А. А.");
});

afterAll(async () => {
  await app?.close();
});

function binary(res: request.Response, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  (res as unknown as NodeJS.ReadableStream).on("data", (c: Buffer) => chunks.push(c));
  (res as unknown as NodeJS.ReadableStream).on("end", () => cb(null, Buffer.concat(chunks)));
}

const log = async (group?: string) =>
  (await admin.get(`/competitions/${competitionId}/audit${group ? `?group=${group}` : ""}`).expect(200)).body as AuditEntry[];

describe("журнал изменений", () => {
  it("записывает оценки судей, их правку, утверждение, возврат и запрос тренера", async () => {
    const perf = (
      await api(app, panel.sv).post(`/competitions/${competitionId}/performances`, { gymnastId: ids.get(1), apparatus: "BB" }).expect(201)
    ).body;
    await api(app, panel.d).post("/marks", { id: randomUUID(), performanceId: perf.id, kind: "D", value: 4 }).expect(201);
    await api(app, panel.d).post("/marks", { id: randomUUID(), performanceId: perf.id, kind: "D", value: 4.5 }).expect(201);
    await api(app, panel.e).post("/marks", { id: randomUUID(), performanceId: perf.id, kind: "E", value: 1.2 }).expect(201);
    await api(app, panel.sv).post(`/performances/${perf.id}/approve`).expect(201);
    const inquiry = (await admin.post(`/performances/${perf.id}/inquiries`, { coach: "Иванова", claimedD: 5 }).expect(201)).body;
    await admin.post(`/inquiries/${inquiry.id}/resolve`, { decision: "accept", d: 5 }).expect(201);

    const marks = await log("marks");
    expect(marks.map((e) => e.text)).toEqual([
      "Оценка утверждена: D 4.500, E 8.800, итог 13.300",
      "Изменена оценка (D): 4.000 → 4.500",
    ]);
    expect(marks[0]).toMatchObject({ actor: "Старший судья · Смирнова О. В.", apparatus: "BB", gymnast: "№1 Абрамова Анна" });
    expect(marks[1]!.actor).toBe("Судья D1 · Петрова И. И.");
    expect((await log("inquiries")).map((e) => [e.actor, e.text])).toEqual([
      ["Секретариат", "Запрос удовлетворён: D 4.500 → 5.000, прежний итог 13.300"],
      ["Секретариат", "Запрос на пересмотр D от тренера Иванова, заявлено 5.000"],
    ]);
  });

  it("записывает правку участников и выдачу QR-кодов", async () => {
    await admin.patch(`/competitions/${competitionId}/gymnasts/${ids.get(2)}`, { club: "Юность", status: "WITHDRAWN" }).expect(200);
    const extra = (await admin.post(`/competitions/${competitionId}/gymnasts`, { bib: 9, lastName: "Зуева", firstName: "Зоя" }).expect(201)).body;
    await admin.delete(`/competitions/${competitionId}/gymnasts/${extra.id}`).expect(200);
    const roster = await log("roster");
    expect(roster.map((e) => [e.gymnast, e.text])).toEqual([
      ["№9 Зуева Зоя", "Участник удалён из списка"],
      ["№9 Зуева Зоя", "Участник добавлен"],
      ["№2 Белова Бэлла", "Изменены данные участника: клуб: Старт → Юность; статус: выступает → снятие"],
      [null, "Загружен список участников: 2 чел."],
    ]);
    const setup = await log("setup");
    expect(setup.map((e) => e.text)).toContain("Заведён судья: Судья E1 · Бревно · Козлова А. А.");
    expect(await api(app).get(`/competitions/${competitionId}/audit`).expect(401));
    await admin.get(`/competitions/${competitionId}/audit?group=nope`).expect(400);
  });

  it("выгружает журнал для жюри в PDF и Excel по времени", async () => {
    const res = await admin.get(`/competitions/${competitionId}/protocols/audit?group=marks`).expect(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    const xlsx = await admin.get(`/competitions/${competitionId}/protocols/audit.xlsx`).buffer(true).parse(binary).expect(200);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(new Uint8Array(xlsx.body as Buffer).buffer);
    const sheet = book.getWorksheet("Журнал изменений")!;
    expect(sheet.rowCount).toBe((await log()).length + 1);
    expect(sheet.getRow(2).getCell(6).value).toBe("Загружен список участников: 2 чел.");
  });
});
