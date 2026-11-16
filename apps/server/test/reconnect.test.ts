import type { INestApplication } from "@nestjs/common";
import { LIVE_EVENTS } from "@ag/shared";
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

const open = (token?: string, device = "tablet-1") =>
  io(`${url}/live`, { transports: ["websocket"], reconnection: false, ...(token ? { auth: { token, device } } : {}) });

const once = (socket: Socket, event: string, ms = 3000) =>
  new Promise<unknown[]>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`нет события ${event}`)), ms);
    socket.once(event, (...args: unknown[]) => {
      clearTimeout(timer);
      resolve(args);
    });
  });

describe("переподключение планшета судьи", () => {
  it("после каждого подключения сервер подтверждает подписку на бригаду, и оценки снова приходят", async () => {
    const competition = (await admin.post("/competitions", { name: "Кубок", discipline: "WAG" }).expect(201)).body;
    const judge = (
      await admin.post(`/competitions/${competition.id}/judges`, { name: "Судья E1", apparatus: "BB", role: "E", seat: 1 }).expect(201)
    ).body as { id: string; token: string };

    const first = open(judge.token);
    const [ready] = await once(first, LIVE_EVENTS.judgeReady);
    expect(ready).toEqual({ judgeId: judge.id });
    first.close();

    // Судья вернулся в зал: новое подключение с тем же кодом снова подписано на бригаду.
    const again = open(judge.token);
    await once(again, LIVE_EVENTS.judgeReady);
    const presence = (await admin.get(`/competitions/${competition.id}/judges/presence`).expect(200)).body as {
      judgeId: string;
      online: boolean;
    }[];
    expect(presence.find((p) => p.judgeId === judge.id)?.online).toBe(true);
    again.close();
  });

  it("недействующий код: сервер сообщает об этом и закрывает подключение", async () => {
    const socket = open("not-a-real-token");
    const rejected = once(socket, LIVE_EVENTS.judgeRejected);
    const closed = once(socket, "disconnect");
    await rejected;
    const [reason] = await closed;
    expect(reason).toBe("io server disconnect");
  });

  it("код, открытый на другом планшете: второй планшет не подписывается на бригаду", async () => {
    const competition = (await admin.post("/competitions", { name: "Кубок 2", discipline: "WAG" }).expect(201)).body;
    const judge = (
      await admin.post(`/competitions/${competition.id}/judges`, { name: "Судья D1", apparatus: "BB", role: "D", seat: 1 }).expect(201)
    ).body as { id: string; token: string };
    const own = open(judge.token, "tablet-own");
    await once(own, LIVE_EVENTS.judgeReady);
    const other = open(judge.token, "tablet-other");
    await once(other, LIVE_EVENTS.judgeRejected);
    // Свой планшет после обрыва снова подключается без вопросов.
    own.close();
    const back = open(judge.token, "tablet-own");
    await once(back, LIVE_EVENTS.judgeReady);
    back.close();
    other.close();
  });

  it("табло и секретариат без кода подключаются как раньше", async () => {
    const socket = open();
    await once(socket, "connect");
    await new Promise((r) => setTimeout(r, 200));
    expect(socket.connected).toBe(true);
    socket.close();
  });
});
