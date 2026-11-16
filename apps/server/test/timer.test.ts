import type { INestApplication } from "@nestjs/common";
import { LIVE_EVENTS, type BoardTimer } from "@ag/shared";
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

describe("таймер на табло", () => {
  it("секретарь запускает и убирает, табло узнаёт по событию и по запросу", async () => {
    const id = (await admin.post("/competitions", { name: "Кубок", discipline: "WAG" }).expect(201)).body.id;
    expect((await api(app).get(`/competitions/${id}/timer`).expect(200)).body).toEqual({ timer: null });

    const board: Socket = io(`${url}/live`, { transports: ["websocket"] });
    await new Promise<void>((resolve) => board.on("connect", resolve));
    board.emit(LIVE_EVENTS.join, { competitionId: id });
    await new Promise((r) => setTimeout(r, 50));
    const got = new Promise<BoardTimer | null>((resolve) => board.once(LIVE_EVENTS.timer, resolve));

    await api(app).put(`/competitions/${id}/timer`, { timer: { label: "Разминка", seconds: 30 } }).expect(401);
    await admin.put(`/competitions/${id}/timer`, { timer: { label: "Разминка", seconds: 30 } }).expect(200);
    const event = await got;
    expect(event).toMatchObject({ label: "Разминка", seconds: 30 });
    expect(event!.remainingMs).toBeGreaterThan(29_000);

    const now = (await api(app).get(`/competitions/${id}/timer`).expect(200)).body.timer as BoardTimer;
    expect(now.remainingMs).toBeLessThanOrEqual(30_000);

    await admin.put(`/competitions/${id}/timer`, { timer: null }).expect(200);
    expect((await api(app).get(`/competitions/${id}/timer`).expect(200)).body.timer).toBeNull();
    await admin.put(`/competitions/${id}/timer`, { timer: { label: "Разминка", seconds: 1 } }).expect(400);
    board.close();
  });
});
