import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import type { AuditEntry, InquiryView } from "@ag/shared";
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
  competitionId = (await admin.post("/competitions", { name: "Кубок тренеров", discipline: "WAG" }).expect(201)).body.id;
  const rows = [
    { bib: 1, lastName: "Абрамова", firstName: "Анна", club: "Олимп" },
    { bib: 2, lastName: "Белова", firstName: "Бэлла", club: "Старт" },
    { bib: 3, lastName: "Васина", firstName: "Вера", club: "Старт" },
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

async function perform(bib: number, d: number) {
  const perf = (
    await api(app, panel.sv).post(`/competitions/${competitionId}/performances`, { gymnastId: ids.get(bib), apparatus: "BB" }).expect(201)
  ).body;
  await api(app, panel.d).post("/marks", { id: randomUUID(), performanceId: perf.id, kind: "D", value: d }).expect(201);
  await api(app, panel.e).post("/marks", { id: randomUUID(), performanceId: perf.id, kind: "E", value: 1 }).expect(201);
  await api(app, panel.sv).post(`/performances/${perf.id}/approve`).expect(201);
  return perf.id as string;
}

describe("запрос тренера с телефона", () => {
  it("записывается на последнюю оценку участника и виден секретариату как поданный с телефона", async () => {
    const url = `/competitions/${competitionId}/coach-inquiries`;
    await api(app).post(url, { gymnastId: ids.get(1), apparatus: "BB", coach: "Иванова" }).expect(404);

    const perfId = await perform(1, 4.5);
    const created = (await api(app).post(url, { gymnastId: ids.get(1), apparatus: "BB", coach: "Иванова", claimedD: 5 }).expect(201))
      .body as InquiryView;
    expect(created).toMatchObject({ performanceId: perfId, source: "phone", late: false, previousD: 4.5, claimedD: 5, status: "PENDING" });

    // Второй запрос на ту же оценку — нет; запрос секретариата помечен по-старому.
    await api(app).post(url, { gymnastId: ids.get(1), apparatus: "BB", coach: "Иванова" }).expect(409);
    const list = (await admin.get(`/competitions/${competitionId}/inquiries`).expect(200)).body as InquiryView[];
    expect(list.map((q) => q.source)).toEqual(["phone"]);

    const audit = (await admin.get(`/competitions/${competitionId}/audit?group=inquiries`).expect(200)).body as AuditEntry[];
    expect(audit[0]).toMatchObject({ actor: "Тренер с телефона", text: "Запрос на пересмотр D от тренера Иванова, заявлено 5.000" });
  });

  it("после показа следующей оценки отправляет тренера в секретариат", async () => {
    await perform(2, 4);
    await perform(3, 4);
    const res = await api(app)
      .post(`/competitions/${competitionId}/coach-inquiries`, { gymnastId: ids.get(2), apparatus: "BB", coach: "Сидоров" })
      .expect(409);
    expect(res.body.message).toContain("Обратитесь в секретариат");
    // Секретариат по-прежнему может записать опоздавший запрос.
    const perfs = (await admin.get(`/competitions/${competitionId}/performances?apparatus=BB`).expect(200)).body as { id: string; gymnastId: string }[];
    const late = (
      await admin.post(`/performances/${perfs.find((p) => p.gymnastId === ids.get(2))!.id}/inquiries`, { coach: "Сидоров" }).expect(201)
    ).body as InquiryView;
    expect(late).toMatchObject({ late: true, source: "secretariat" });
  });

  it("не даёт одному телефону засыпать секретариат запросами", async () => {
    const url = `/competitions/${competitionId}/coach-inquiries`;
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await api(app).post(url, { gymnastId: ids.get(3), apparatus: "BB", coach: "Петров" })).status);
    }
    // В предыдущих тестах с этого адреса уже было 4 подачи: лимит 5 за 10 минут.
    expect(statuses[0]).toBe(201);
    expect(statuses.slice(1)).toEqual([429, 429, 429]);
    await api(app).post(url, { gymnastId: ids.get(3), apparatus: "XX", coach: "Петров" }).expect(400);
  });
});
