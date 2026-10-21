import type { INestApplication } from "@nestjs/common";
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

const connect = async (token: string) => {
  const socket: Socket = io(`${url}/live`, { transports: ["websocket"], auth: { token } });
  await new Promise<void>((resolve) => socket.on("connect", resolve));
  return socket;
};

const presence = async (competitionId: string) =>
  (await admin.get(`/competitions/${competitionId}/judges/presence`).expect(200)).body as {
    judgeId: string;
    online: boolean;
    since: string | null;
    lastSeen: string | null;
  }[];

/** Ждём, пока сервер обработает отключение. */
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 50; i++) {
    const value = await read();
    if (ok(value)) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  return read();
}

describe("связь судей", () => {
  it("показывает секретарю, кто на связи, кто отключился и кто не подключался", async () => {
    const competition = (await admin.post("/competitions", { name: "Кубок", discipline: "WAG" }).expect(201)).body;
    const judge = async (role: string, seat: number) =>
      (await admin.post(`/competitions/${competition.id}/judges`, { name: `Судья ${role}${seat}`, apparatus: "BB", role, seat }).expect(201))
        .body as { id: string; token: string };
    const d = await judge("D", 1);
    const e1 = await judge("E", 1);
    const e2 = await judge("E", 2);

    let list = await presence(competition.id);
    expect(list.every((p) => !p.online && p.lastSeen === null)).toBe(true);

    const dSocket = await connect(d.token);
    // Две вкладки одного судьи: закрытие одной не обрывает связь.
    const e1First = await connect(e1.token);
    const e1Second = await connect(e1.token);
    list = await presence(competition.id);
    const byId = (id: string) => list.find((p) => p.judgeId === id)!;
    expect(byId(d.id)).toMatchObject({ online: true, lastSeen: null });
    expect(byId(d.id).since).not.toBeNull();
    expect(byId(e1.id).online).toBe(true);
    expect(byId(e2.id)).toMatchObject({ online: false, since: null, lastSeen: null });

    e1First.close();
    dSocket.close();
    list = await until(() => presence(competition.id), (l) => !l.find((p) => p.judgeId === d.id)!.online);
    expect(byId(d.id).online).toBe(false);
    expect(byId(d.id).lastSeen).not.toBeNull();
    expect(byId(e1.id).online).toBe(true);

    // Судье список недоступен: только секретариату.
    await api(app, e1.token).get(`/competitions/${competition.id}/judges/presence`).expect(403);
    e1Second.close();
  });
});
