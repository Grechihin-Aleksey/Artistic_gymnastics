import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, api, startApp } from "./helpers";

let app: INestApplication;
let admin: ReturnType<typeof api>;

beforeAll(async () => {
  ({ app } = await startApp());
  admin = api(app, ADMIN_TOKEN);
});

afterAll(async () => {
  await app?.close();
});

const login = (secret: string) => request(app.getHttpServer()).post("/auth/login").send({ secret });

describe("вход в секретариат", () => {
  it("пускает токеном из .env, пока пароль не задан, и выдаёт отдельный вход", async () => {
    await login("какой-то пароль").expect(401);
    const r = await login(ADMIN_TOKEN).expect(200);
    expect(r.body.passwordSet).toBe(false);
    expect(r.body.token).not.toBe(ADMIN_TOKEN);
    await api(app, r.body.token).get("/auth/session").expect(200);
    await api(app, r.body.token).post("/competitions", { name: "Кубок", discipline: "WAG" }).expect(201);
  });

  it("пароль закрывает прежние входы; «выйти на всех устройствах» закрывает все", async () => {
    const before = (await login(ADMIN_TOKEN).expect(200)).body.token as string;
    await admin.put("/auth/password", { password: "короткий" }).expect(200);
    await api(app, before).get("/auth/session").expect(401);
    await admin.put("/auth/password", { password: "123" }).expect(400);

    const first = (await login("короткий").expect(200)).body.token as string;
    const second = (await login("короткий").expect(200)).body.token as string;
    await api(app, first).post("/auth/logout").expect(200);
    await api(app, first).get("/auth/session").expect(401);
    await api(app, second).get("/auth/session").expect(200);

    await api(app, second).post("/auth/logout-all").expect(200);
    await api(app, second).get("/auth/session").expect(401);
    // Токен из .env работает всегда: им чинят забытый пароль.
    await admin.get("/auth/session").expect(200);
  });

  it("после 5 неверных паролей закрывает вход паролем, но не токеном", async () => {
    await admin.put("/auth/password", { password: "верный-пароль" }).expect(200);
    for (let i = 0; i < 4; i++) await login("неверный").expect(401);
    const fifth = await login("неверный").expect(429);
    expect(fifth.body.message).toContain("15 минут");
    const locked = await login("верный-пароль").expect(429);
    expect(locked.body.message).toContain("токеном");
    await login(ADMIN_TOKEN).expect(200);
  });
});

describe("код судьи на одном планшете", () => {
  it("работает на первом планшете, другой ждёт разрешения секретариата", async () => {
    const competition = (await admin.post("/competitions", { name: "Первенство", discipline: "WAG" }).expect(201)).body;
    const judge = (await admin.post(`/competitions/${competition.id}/judges`, { name: "Иванова", apparatus: "BB", role: "E", seat: 1 }).expect(201))
      .body as { id: string; token: string };
    const me = (device: string) => request(app.getHttpServer()).get("/me").set("Authorization", `Bearer ${judge.token}`).set("X-Device", device);

    await me("tablet-1").expect(200);
    await me("tablet-1").expect(200);
    const busy = await me("stranger").expect(403);
    expect(busy.body.message).toContain("другом планшете");

    let list = (await admin.get(`/competitions/${competition.id}/judges`).expect(200)).body as { tabletBound: boolean; tabletPending: boolean }[];
    expect(list[0]).toMatchObject({ tabletBound: true, tabletPending: true });
    expect(list[0]).not.toHaveProperty("deviceId");

    await admin.post(`/judges/${judge.id}/allow-tablet`).expect(201);
    await me("stranger").expect(200);
    await me("tablet-1").expect(403);

    // Новый QR-код снова открывается на любом планшете, старый не работает нигде.
    const fresh = (await admin.post(`/judges/${judge.id}/token`).expect(201)).body as { token: string };
    await me("stranger").expect(401);
    await request(app.getHttpServer()).get("/me").set("Authorization", `Bearer ${fresh.token}`).set("X-Device", "tablet-3").expect(200);
    list = (await admin.get(`/competitions/${competition.id}/judges`).expect(200)).body;
    expect(list[0]).toMatchObject({ tabletBound: true, tabletPending: false });
  });
});
