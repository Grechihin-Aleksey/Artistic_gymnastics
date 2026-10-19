import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import type { ApparatusResultRow, InquiryView, PerformanceView } from "@ag/shared";
import type request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { droppedDeductions } from "../src/protocols/protocols.service";
import { ADMIN_TOKEN, api, startApp } from "./helpers";

let app: INestApplication;
let admin: ReturnType<typeof api>;
let competitionId: string;
const gymnastIds: string[] = [];
const panel = { d: "", e: [] as string[], sv: "" };

beforeAll(async () => {
  ({ app } = await startApp());
  admin = api(app, ADMIN_TOKEN);
  const competition = (
    await admin
      .post("/competitions", { name: "Кубок области", discipline: "WAG", teamFormat: { roster: 3, perApparatus: 3, counting: 2 } })
      .expect(201)
  ).body;
  competitionId = competition.id;
  const team = (await admin.post(`/competitions/${competitionId}/teams`, { name: "СШОР №1" }).expect(201)).body;
  for (const [i, [first, last]] of [["Анна", "Иванова"], ["Мария", "Петрова"], ["Ксения", "Волкова"]].entries()) {
    const g = (
      await admin
        .post(`/competitions/${competitionId}/gymnasts`, { bib: 10 + i, firstName: first, lastName: last, teamId: team.id })
        .expect(201)
    ).body;
    gymnastIds.push(g.id);
  }
  const judge = async (role: string, seat: number) =>
    (await admin.post(`/competitions/${competitionId}/judges`, { name: `${role}${seat}`, apparatus: "BB", role, seat }).expect(201))
      .body.token as string;
  panel.d = await judge("D", 1);
  for (let s = 1; s <= 5; s++) panel.e.push(await judge("E", s));
  panel.sv = await judge("SUPERVISOR", 1);
});

afterAll(async () => {
  await app?.close();
});

/** Вызов, оценки всех судей и утверждение. */
async function perform(gymnastId: string, d: number, eDeductions: number[]): Promise<PerformanceView> {
  const perf = (await admin.post(`/competitions/${competitionId}/performances`, { gymnastId, apparatus: "BB" }).expect(201)).body;
  await api(app, panel.d).post("/marks", { id: randomUUID(), performanceId: perf.id, kind: "D", value: d }).expect(201);
  for (const [i, value] of eDeductions.entries()) {
    await api(app, panel.e[i]).post("/marks", { id: randomUUID(), performanceId: perf.id, kind: "E", value }).expect(201);
  }
  return (await api(app, panel.sv).post(`/performances/${perf.id}/approve`).expect(201)).body;
}

const pdf = (path: string, token = ADMIN_TOKEN) =>
  api(app, token)
    .get(path)
    .buffer(true)
    .parse(binary);

/** supertest по умолчанию не собирает тело PDF в Buffer. */
function binary(res: request.Response, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  (res as unknown as NodeJS.ReadableStream).on("data", (c: Buffer) => chunks.push(c));
  (res as unknown as NodeJS.ReadableStream).on("end", () => cb(null, Buffer.concat(chunks)));
}

describe("крайние сбавки в протоколе", () => {
  it("отмечает по одной крайней при 5 судьях и по две при 7", () => {
    expect(droppedDeductions([1.2, 1.4, 1.3, 1.0, 1.6])).toEqual([false, false, false, true, true]);
    expect(droppedDeductions([1, 2, 3, 4, 5, 6, 7])).toEqual([true, true, false, false, false, true, true]);
    // При равных значениях отбрасывается первое по порядку мест.
    expect(droppedDeductions([1, 1, 2, 3])).toEqual([true, false, false, true]);
    expect(droppedDeductions([1, 2, 3])).toEqual([false, false, false]);
  });
});

describe("запрос на пересмотр D", () => {
  let first: PerformanceView;

  it("подаётся только на утверждённую оценку и не дважды одновременно", async () => {
    const open = (await admin.post(`/competitions/${competitionId}/performances`, { gymnastId: gymnastIds[0], apparatus: "BB" }).expect(201)).body;
    await admin.post(`/performances/${open.id}/inquiries`, { coach: "Смирнова" }).expect(409);
    await api(app, panel.d).post("/marks", { id: randomUUID(), performanceId: open.id, kind: "D", value: 5.2 }).expect(201);
    for (const [i, value] of [1.2, 1.4, 1.3, 1.0, 1.6].entries()) {
      await api(app, panel.e[i]).post("/marks", { id: randomUUID(), performanceId: open.id, kind: "E", value }).expect(201);
    }
    first = (await api(app, panel.sv).post(`/performances/${open.id}/approve`).expect(201)).body;
    expect(first.score!.total).toBe(13.9);

    await api(app, panel.sv).post(`/performances/${first.id}/inquiries`, { coach: "Смирнова" }).expect(403);
    const inquiry = (await admin.post(`/performances/${first.id}/inquiries`, { coach: "Смирнова", claimedD: 5.5 }).expect(201))
      .body as InquiryView;
    expect(inquiry).toMatchObject({ status: "PENDING", previousD: 5.2, claimedD: 5.5, late: false, apparatus: "BB" });
    expect(inquiry.gymnast.lastName).toBe("Иванова");
    await admin.post(`/performances/${first.id}/inquiries`, { coach: "Смирнова" }).expect(409);
  });

  it("удовлетворённый запрос меняет D, итог и таблицы, решение нельзя принять дважды", async () => {
    const [inquiry] = (await admin.get(`/competitions/${competitionId}/inquiries`).expect(200)).body as InquiryView[];
    await admin.post(`/inquiries/${inquiry!.id}/resolve`, { decision: "accept" }).expect(400);
    const resolved = (await admin.post(`/inquiries/${inquiry!.id}/resolve`, { decision: "accept", d: 5.5, note: "Засчитан элемент D" }).expect(201))
      .body as InquiryView;
    expect(resolved).toMatchObject({ status: "ACCEPTED", newD: 5.5, note: "Засчитан элемент D" });
    await admin.post(`/inquiries/${inquiry!.id}/resolve`, { decision: "reject" }).expect(409);

    const perf = (await admin.get(`/performances/${first.id}`).expect(200)).body as PerformanceView;
    expect(perf.score).toEqual({ d: 5.5, e: 8.7, neutral: 0, total: 14.2 });
    const table = (await api(app).get(`/competitions/${competitionId}/results/apparatus/BB`).expect(200)).body as ApparatusResultRow[];
    expect(table[0]!.score.total).toBe(14.2);
  });

  it("после оценки следующего участника запрос считается поданным с опозданием, отказ ничего не меняет", async () => {
    const second = await perform(gymnastIds[1]!, 5.0, [1.0, 1.1, 1.2, 1.3, 1.4]);
    const late = (await admin.post(`/performances/${first.id}/inquiries`, { coach: "Смирнова" }).expect(201)).body as InquiryView;
    expect(late.late).toBe(true);
    const onTime = (await admin.post(`/performances/${second.id}/inquiries`, { coach: "Кузнецова" }).expect(201)).body as InquiryView;
    expect(onTime.late).toBe(false);
    await admin.post(`/inquiries/${late.id}/resolve`, { decision: "reject" }).expect(201);
    const perf = (await admin.get(`/performances/${first.id}`).expect(200)).body as PerformanceView;
    expect(perf.score!.total).toBe(14.2);
    const list = (await admin.get(`/competitions/${competitionId}/inquiries`).expect(200)).body as InquiryView[];
    expect(list.map((i) => i.status)).toEqual(["ACCEPTED", "REJECTED", "PENDING"]);
  });
});

describe("протоколы", () => {
  it("секретариат получает протоколы в PDF", async () => {
    await perform(gymnastIds[2]!, 4.8, [0.9, 1.0, 1.1, 1.2, 1.3]);
    for (const path of ["apparatus/BB", "all-around", "teams"]) {
      const res = await pdf(`/competitions/${competitionId}/protocols/${path}`).expect(200);
      expect(res.headers["content-type"]).toBe("application/pdf");
      const body = res.body as Buffer;
      expect(body.subarray(0, 5).toString()).toBe("%PDF-");
      expect(body.length).toBeGreaterThan(5000);
    }
  });

  it("пустой протокол тоже собирается, а без токена секретариата недоступен", async () => {
    await pdf(`/competitions/${competitionId}/protocols/apparatus/VT`).expect(200);
    await pdf(`/competitions/${competitionId}/protocols/all-around`, "").expect(401);
    await pdf(`/competitions/${competitionId}/protocols/apparatus/PH`).expect(422);
  });
});
