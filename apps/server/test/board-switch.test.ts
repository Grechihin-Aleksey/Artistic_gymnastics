import type { INestApplication } from "@nestjs/common";
import { LIVE_EVENTS, type BoardSwitch } from "@ag/shared";
import { io } from "socket.io-client";
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

describe("табло турнира из двух частей", () => {
  it("секретариат включает чередование или выводит часть, обе части и их табло это узнают", async () => {
    const girls = (await admin.post("/competitions", { name: "Кубок", discipline: "WAG" }).expect(201)).body;
    const boys = (await admin.post("/competitions", { name: "Кубок", discipline: "MAG", pairWith: girls.id }).expect(201)).body;
    expect(girls.boardSwitch).toBeNull();

    // Табло мужской части слушает свою комнату.
    const socket = io(`${url}/live`, { transports: ["websocket"] });
    await new Promise<void>((resolve) => socket.on("connect", resolve));
    socket.emit(LIVE_EVENTS.join, { competitionId: boys.id });
    await new Promise((r) => setTimeout(r, 200));
    const heard = new Promise<BoardSwitch>((resolve) => socket.on(LIVE_EVENTS.boardSwitch, resolve));

    const auto = (await admin.put(`/competitions/${girls.id}/board-switch`, { mode: "auto", every: 20 }).expect(200)).body.boardSwitch;
    expect(auto).toMatchObject({ mode: "auto", every: 20 });
    expect((await heard).at).toBe(auto.at);
    socket.close();
    expect((await admin.get(`/competitions/${boys.id}`).expect(200)).body.boardSwitch).toEqual(auto);

    const show = (await admin.put(`/competitions/${boys.id}/board-switch`, { mode: "show", show: boys.id }).expect(200)).body.boardSwitch;
    expect(show).toMatchObject({ mode: "show", show: boys.id, every: 30 });
    expect((await admin.get(`/competitions/${girls.id}`).expect(200)).body.boardSwitch).toEqual(show);

    const audit = (await admin.get(`/competitions/${boys.id}/audit`).expect(200)).body as { text: string }[];
    expect(audit.map((a) => a.text)).toContain("На табло выведена мужская программа");
  });

  it("одна часть, чужая часть и неверные данные отклоняются", async () => {
    const single = (await admin.post("/competitions", { name: "Один", discipline: "WAG" }).expect(201)).body;
    await admin.put(`/competitions/${single.id}/board-switch`, { mode: "auto" }).expect(400);
    const girls = (await admin.post("/competitions", { name: "Пара", discipline: "WAG" }).expect(201)).body;
    await admin.post("/competitions", { name: "Пара", discipline: "MAG", pairWith: girls.id }).expect(201);
    await admin.put(`/competitions/${girls.id}/board-switch`, { mode: "show", show: single.id }).expect(400);
    await admin.put(`/competitions/${girls.id}/board-switch`, { mode: "show" }).expect(400);
    await admin.put(`/competitions/${girls.id}/board-switch`, { mode: "auto", every: 3 }).expect(400);
    await api(app).put(`/competitions/${girls.id}/board-switch`, { mode: "board" }).expect(401);
  });
});
