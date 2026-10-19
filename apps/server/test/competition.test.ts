import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { LIVE_EVENTS, type PerformanceView } from "@ag/shared";
import { io, type Socket } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, api, startApp } from "./helpers";

let app: INestApplication;
let url: string;
let admin: ReturnType<typeof api>;

beforeAll(async () => {
  ({ app, url } = await startApp());
  admin = api(app, ADMIN_TOKEN);
});

afterAll(async () => {
  await app?.close();
});

interface Panel {
  d: string;
  e: string[];
  supervisor: string;
}

async function setupCompetition(eJudges = 5) {
  const competition = (await admin.post("/competitions", { name: "Кубок города", discipline: "WAG" }).expect(201)).body;
  const team = (await admin.post(`/competitions/${competition.id}/teams`, { name: "Сборная" }).expect(201)).body;
  const gymnast = (
    await admin
      .post(`/competitions/${competition.id}/gymnasts`, {
        bib: 7,
        firstName: "Анна",
        lastName: "Иванова",
        teamId: team.id,
      })
      .expect(201)
  ).body;
  const addJudge = async (role: string, seat: number, apparatus = "BB") =>
    (
      await admin
        .post(`/competitions/${competition.id}/judges`, { name: `${role}${seat}`, apparatus, role, seat })
        .expect(201)
    ).body.token as string;
  const panel: Panel = {
    d: await addJudge("D", 1),
    e: await Promise.all(Array.from({ length: eJudges }, (_, i) => addJudge("E", i + 1))),
    supervisor: await addJudge("SUPERVISOR", 1),
  };
  return { competition, team, gymnast, panel };
}

const mark = (token: string, performanceId: string, kind: string, value: number, id = randomUUID()) =>
  api(app, token).post("/marks", { id, performanceId, kind, value });

describe("доступ", () => {
  it("не даёт создать соревнование без токена секретариата", async () => {
    await api(app).post("/competitions", { name: "x", discipline: "MAG" }).expect(401);
    const { panel } = await setupCompetition(1);
    await api(app, panel.d).post("/competitions", { name: "x", discipline: "MAG" }).expect(403);
  });

  it("проверяет данные запроса", async () => {
    const res = await admin.post("/competitions", { name: "", discipline: "XX" }).expect(400);
    expect(res.body.issues.length).toBeGreaterThan(0);
  });

  it("не отдаёт токены судей в списке", async () => {
    const { competition } = await setupCompetition(1);
    const res = await admin.get(`/competitions/${competition.id}/judges`).expect(200);
    expect(res.body[0]).not.toHaveProperty("token");
    expect(res.body[0]).not.toHaveProperty("tokenHash");
  });
});

describe("судья", () => {
  it("по токену узнаёт свой снаряд, а новый токен отменяет старый", async () => {
    const { competition, panel } = await setupCompetition(1);
    const me = (await api(app, panel.e[0]).get("/me").expect(200)).body;
    expect(me.judge).toMatchObject({ apparatus: "BB", role: "E", seat: 1 });
    expect(me.judge).not.toHaveProperty("tokenHash");
    expect(me.competition.id).toBe(competition.id);
    await admin.get("/me").expect(403);

    const reissued = (await admin.post(`/judges/${me.judge.id}/token`).expect(201)).body;
    await api(app, panel.e[0]).get("/me").expect(401);
    await api(app, reissued.token).get("/me").expect(200);
  });
});

describe("выступление на бревне", () => {
  it("собирает оценки, считает итог по FIG и рассылает его", async () => {
    const { competition, gymnast, panel } = await setupCompetition();

    const viewer: Socket = io(`${url}/live`, { transports: ["websocket"] });
    await new Promise<void>((resolve) => viewer.on("connect", resolve));
    await viewer.emitWithAck(LIVE_EVENTS.join, { competitionId: competition.id });
    const approvedEvent = new Promise<PerformanceView>((resolve) => viewer.on(LIVE_EVENTS.approved, resolve));

    const supervisorSocket: Socket = io(`${url}/live`, { transports: ["websocket"], auth: { token: panel.supervisor } });
    await new Promise<void>((resolve) => supervisorSocket.on("connect", resolve));
    const marksEvents: PerformanceView[] = [];
    supervisorSocket.on(LIVE_EVENTS.marksUpdated, (v: PerformanceView) => marksEvents.push(v));

    const perf = (
      await admin
        .post(`/competitions/${competition.id}/performances`, { gymnastId: gymnast.id, apparatus: "BB" })
        .expect(201)
    ).body as PerformanceView;
    expect(perf.status).toBe("SCORING");

    await mark(panel.d, perf.id, "D", 5.8).expect(201);
    await mark(panel.d, perf.id, "NEUTRAL", 0.1).expect(201);
    const deductions = [1.2, 1.4, 1.3, 1.6, 1.1];
    for (const [i, value] of deductions.entries()) {
      await mark(panel.e[i]!, perf.id, "E", value).expect(201);
    }

    const approved = (await api(app, panel.supervisor).post(`/performances/${perf.id}/approve`).expect(201))
      .body as PerformanceView;
    expect(approved.status).toBe("APPROVED");
    expect(approved.score).toEqual({ d: 5.8, e: 8.7, neutral: 0.1, total: 14.4 });

    const live = await approvedEvent;
    expect(live.score?.total).toBe(14.4);
    expect(live.marks).toEqual([]);
    expect(marksEvents.length).toBe(7);

    const results = (await api(app).get(`/competitions/${competition.id}/results/apparatus/BB`).expect(200)).body;
    expect(results).toEqual([
      expect.objectContaining({ rank: 1, score: { d: 5.8, e: 8.7, neutral: 0.1, total: 14.4 } }),
    ]);

    viewer.close();
    supervisorSocket.close();
  });

  it("не утверждает, пока не пришли все оценки E", async () => {
    const { competition, gymnast, panel } = await setupCompetition(3);
    const perf = (
      await admin.post(`/competitions/${competition.id}/performances`, { gymnastId: gymnast.id, apparatus: "BB" })
    ).body;
    await mark(panel.d, perf.id, "D", 5).expect(201);
    await mark(panel.e[0]!, perf.id, "E", 1).expect(201);
    const res = await api(app, panel.supervisor).post(`/performances/${perf.id}/approve`).expect(409);
    expect(res.body.message).toBe("Оценки E: 1 из 3");
  });

  it("повторная отправка той же оценки не создаёт дубль, а исправление заменяет оценку", async () => {
    const { competition, gymnast, panel } = await setupCompetition(1);
    const perf = (
      await admin.post(`/competitions/${competition.id}/performances`, { gymnastId: gymnast.id, apparatus: "BB" })
    ).body;
    const id = randomUUID();
    await mark(panel.e[0]!, perf.id, "E", 1.5, id).expect(201);
    await mark(panel.e[0]!, perf.id, "E", 1.5, id).expect(201);
    await mark(panel.e[0]!, perf.id, "E", 1.2).expect(201);
    const view = (await admin.get(`/performances/${perf.id}`).expect(200)).body as PerformanceView;
    expect(view.marks.filter((m) => m.kind === "E")).toEqual([expect.objectContaining({ value: 1.2 })]);
  });

  it("не принимает оценку не своей роли и не своего снаряда", async () => {
    const { competition, gymnast, panel } = await setupCompetition(1);
    const perf = (
      await admin.post(`/competitions/${competition.id}/performances`, { gymnastId: gymnast.id, apparatus: "BB" })
    ).body;
    await mark(panel.e[0]!, perf.id, "D", 5).expect(403);
    const otherApparatus = (
      await admin
        .post(`/competitions/${competition.id}/judges`, { name: "E1 UB", apparatus: "UB", role: "E", seat: 1 })
        .expect(201)
    ).body.token;
    await mark(otherApparatus, perf.id, "E", 1).expect(403);
  });

  it("после утверждения оценки закрыты, а возврат на правку снимает итог", async () => {
    const { competition, gymnast, panel } = await setupCompetition(1);
    const perf = (
      await admin.post(`/competitions/${competition.id}/performances`, { gymnastId: gymnast.id, apparatus: "BB" })
    ).body;
    await mark(panel.d, perf.id, "D", 5).expect(201);
    await mark(panel.e[0]!, perf.id, "E", 1).expect(201);
    await api(app, panel.supervisor).post(`/performances/${perf.id}/approve`).expect(201);
    await mark(panel.e[0]!, perf.id, "E", 2).expect(409);

    await api(app, panel.supervisor).post(`/performances/${perf.id}/reopen`, { reason: "пересмотр D" }).expect(403);
    const reopened = (await admin.post(`/performances/${perf.id}/reopen`, { reason: "пересмотр D" }).expect(201))
      .body as PerformanceView;
    expect(reopened.status).toBe("SCORING");
    expect(reopened.score).toBeNull();
    await mark(panel.d, perf.id, "D", 5.2).expect(201);
    const again = (await admin.post(`/performances/${perf.id}/approve`).expect(201)).body as PerformanceView;
    expect(again.score?.total).toBe(14.2);
  });
});

describe("таблицы результатов", () => {
  async function score(
    competitionId: string,
    gymnastId: string,
    apparatus: string,
    judges: { d: string; e: string; supervisor: string },
    d: number,
    e: number,
    attempt = 1,
  ) {
    const perf = (
      await admin
        .post(`/competitions/${competitionId}/performances`, { gymnastId, apparatus, attempt })
        .expect(201)
    ).body;
    await mark(judges.d, perf.id, "D", d).expect(201);
    await mark(judges.e, perf.id, "E", e).expect(201);
    await api(app, judges.supervisor).post(`/performances/${perf.id}/approve`).expect(201);
  }

  it("считает многоборье, опорный прыжок и команду", async () => {
    const competition = (await admin.post("/competitions", { name: "Первенство", discipline: "WAG" })).body;
    const team = (await admin.post(`/competitions/${competition.id}/teams`, { name: "Клуб" })).body;
    const panels: Record<string, { d: string; e: string; supervisor: string }> = {};
    for (const apparatus of ["VT", "UB", "BB", "FX"]) {
      const add = async (role: string) =>
        (
          await admin.post(`/competitions/${competition.id}/judges`, { name: role, apparatus, role, seat: 1 })
        ).body.token;
      panels[apparatus] = { d: await add("D"), e: await add("E"), supervisor: await add("SUPERVISOR") };
    }
    const people = [];
    for (const [bib, name] of [
      [1, "Анна"],
      [2, "Вера"],
      [3, "Ольга"],
    ] as const) {
      people.push(
        (
          await admin.post(`/competitions/${competition.id}/gymnasts`, {
            bib,
            firstName: name,
            lastName: "Тест",
            teamId: team.id,
          })
        ).body.id,
      );
    }
    const [anna, vera, olga] = people;
    // Анна: 14 + 13 + 13 + 12 = 52, Вера: 13 × 4 = 52 → при равенстве выше Анна (сумма без худшей 40 > 39).
    await score(competition.id, anna, "VT", panels.VT!, 5, 1);
    await score(competition.id, anna, "VT", panels.VT!, 5, 2, 2);
    await score(competition.id, anna, "UB", panels.UB!, 4, 1);
    await score(competition.id, anna, "BB", panels.BB!, 4, 1);
    await score(competition.id, anna, "FX", panels.FX!, 3, 1);
    for (const a of ["VT", "UB", "BB", "FX"]) await score(competition.id, vera, a, panels[a]!, 4, 1);
    await score(competition.id, olga, "BB", panels.BB!, 5, 0.5);

    const allAround = (await api(app).get(`/competitions/${competition.id}/results/all-around`).expect(200)).body;
    expect(allAround.map((r: any) => [r.gymnast.firstName, r.rank, r.total, r.complete])).toEqual([
      ["Анна", 1, 52, true],
      ["Вера", 2, 52, true],
      ["Ольга", 3, 14.5, false],
    ]);

    const vault = (await api(app).get(`/competitions/${competition.id}/results/apparatus/VT`).expect(200)).body;
    expect(vault[0]).toMatchObject({ gymnast: { firstName: "Анна" }, score: { total: 13.5 } });
    const vaultFirst = (
      await api(app).get(`/competitions/${competition.id}/results/apparatus/VT?vault=first`).expect(200)
    ).body;
    expect(vaultFirst[0]).toMatchObject({ gymnast: { firstName: "Анна" }, score: { total: 14 } });

    const teams = (await api(app).get(`/competitions/${competition.id}/results/teams`).expect(200)).body;
    // VT 14+13, UB 13+13, BB 14.5+13+13, FX 13+12
    expect(teams[0]).toMatchObject({ rank: 1, team: { name: "Клуб" }, total: 27 + 26 + 40.5 + 25 });

    await api(app).get(`/competitions/${competition.id}/results/apparatus/PH`).expect(422);
  });
});
