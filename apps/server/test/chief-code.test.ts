import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import type { AuditEntry, InquiryView } from "@ag/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, api, startApp } from "./helpers";

let app: INestApplication;
let admin: ReturnType<typeof api>;
let competitionId: string;
let otherId: string;
const panel = { d: "", e: "", sv: "" };
let gymnastId: string;

beforeAll(async () => {
  ({ app } = await startApp());
  admin = api(app, ADMIN_TOKEN);
  competitionId = (await admin.post("/competitions", { name: "Кубок главного судьи", discipline: "WAG" }).expect(201)).body.id;
  otherId = (await admin.post("/competitions", { name: "Чужой турнир", discipline: "WAG" }).expect(201)).body.id;
  gymnastId = (
    await admin.post(`/competitions/${competitionId}/gymnasts/import`, { rows: [{ bib: 1, lastName: "Абрамова", firstName: "Анна" }] }).expect(201)
  ).body[0].id;
  const judge = async (role: string, name: string) =>
    (await admin.post(`/competitions/${competitionId}/judges`, { name, apparatus: "BB", role, seat: 1 }).expect(201)).body.token as string;
  panel.sv = await judge("SUPERVISOR", "Смирнова О. В.");
  panel.d = await judge("D", "Петрова И. И.");
  panel.e = await judge("E", "Козлова А. А.");
});

afterAll(async () => {
  await app?.close();
});

describe("главный судья на отдельном планшете", () => {
  it("секретариат выдаёт код; код видит свой турнир, разбирает запросы, но не правит турнир", async () => {
    expect((await admin.get(`/competitions/${competitionId}/chief-code`).expect(200)).body.token).toBeNull();
    const { token } = (await admin.post(`/competitions/${competitionId}/chief-code`).expect(201)).body as { token: string };
    expect((await admin.get(`/competitions/${competitionId}/chief-code`).expect(200)).body.token).toBe(token);
    // Код не виден в открытых данных турнира.
    const pub = (await api(app).get(`/competitions/${competitionId}`).expect(200)).body;
    expect(JSON.stringify(pub)).not.toContain("chiefToken");

    const chief = api(app, token);
    expect((await chief.get("/chief/me").expect(200)).body).toMatchObject({ competitionId, competitions: [{ id: competitionId }] });
    await chief.get(`/competitions/${competitionId}/performances`).expect(200);
    await chief.get(`/competitions/${competitionId}/judges`).expect(200);
    await chief.get(`/competitions/${competitionId}/inquiries`).expect(200);
    // Чужой турнир и действия секретариата — нет.
    await chief.get(`/competitions/${otherId}/inquiries`).expect(403);
    await chief.get(`/competitions/${otherId}/performances`).expect(403);
    await chief.post(`/competitions/${competitionId}/judges`, { name: "X", apparatus: "BB", role: "E", seat: 2 }).expect(403);
    await chief.get(`/competitions/${competitionId}/chief-code`).expect(403);
    await chief.get("/me").expect(403);

    const perf = (await api(app, panel.sv).post(`/competitions/${competitionId}/performances`, { gymnastId, apparatus: "BB" }).expect(201)).body;
    await api(app, panel.d).post("/marks", { id: randomUUID(), performanceId: perf.id, kind: "D", value: 4 }).expect(201);
    await api(app, panel.e).post("/marks", { id: randomUUID(), performanceId: perf.id, kind: "E", value: 1 }).expect(201);
    await chief.post(`/performances/${perf.id}/approve`).expect(403);
    await api(app, panel.sv).post(`/performances/${perf.id}/approve`).expect(201);

    const inquiry = (await chief.post(`/performances/${perf.id}/inquiries`, { coach: "Иванова", claimedD: 4.5 }).expect(201)).body as InquiryView;
    const resolved = (await chief.post(`/inquiries/${inquiry.id}/resolve`, { decision: "accept", d: 4.5 }).expect(201)).body as InquiryView;
    expect(resolved).toMatchObject({ status: "ACCEPTED", newD: 4.5 });
    const audit = (await admin.get(`/competitions/${competitionId}/audit?group=inquiries`).expect(200)).body as AuditEntry[];
    expect(audit.map((a) => a.actor)).toEqual(["Главный судья", "Главный судья"]);

    // Новый код — старый больше не действует.
    const { token: fresh } = (await admin.post(`/competitions/${competitionId}/chief-code`).expect(201)).body as { token: string };
    await chief.get("/chief/me").expect(401);
    await api(app, fresh).get("/chief/me").expect(200);
  });

  it("у турнира из двух частей один код на обе части", async () => {
    const girls = (await admin.post("/competitions", { name: "Первенство", discipline: "WAG" }).expect(201)).body.id as string;
    const boys = (await admin.post("/competitions", { name: "Первенство", discipline: "MAG", pairWith: girls }).expect(201)).body.id as string;
    const { token, competitionId: owner } = (await admin.post(`/competitions/${boys}/chief-code`).expect(201)).body as { token: string; competitionId: string };
    expect(owner).toBe(girls);
    expect((await admin.get(`/competitions/${girls}/chief-code`).expect(200)).body.token).toBe(token);
    const me = (await api(app, token).get("/chief/me").expect(200)).body as { competitions: { id: string }[] };
    expect(me.competitions.map((c) => c.id).sort()).toEqual([girls, boys].sort());
    await api(app, token).get(`/competitions/${boys}/inquiries`).expect(200);
  });
});
