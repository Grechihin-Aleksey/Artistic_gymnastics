import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB, type Db } from "../src/db/db.module";
import { judges } from "../src/db/schema";
import { openToken, sealToken } from "../src/auth/tokens";
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

describe("перепечатка QR-кодов судей", () => {
  it("шифрует токен ключом секретариата", () => {
    const sealed = sealToken("judge-token", ADMIN_TOKEN);
    expect(sealed).not.toContain("judge-token");
    expect(openToken(sealed, ADMIN_TOKEN)).toBe("judge-token");
    expect(openToken(sealed, "другой-токен-секретариата")).toBeNull();
    expect(openToken(null, ADMIN_TOKEN)).toBeNull();
  });

  it("отдаёт прежние коды всех судей, и они продолжают работать", async () => {
    const competition = (await admin.post("/competitions", { name: "Кубок", discipline: "WAG" }).expect(201)).body;
    const add = async (role: string, seat: number) =>
      (await admin.post(`/competitions/${competition.id}/judges`, { name: `${role}${seat}`, apparatus: "BB", role, seat }).expect(201))
        .body as { id: string; token: string };
    const sv = await add("SUPERVISOR", 1);
    const e = await add("E", 1);

    await api(app).get(`/competitions/${competition.id}/judges/codes`).expect(401);
    await api(app, sv.token).get(`/competitions/${competition.id}/judges/codes`).expect(403);
    let codes = (await admin.get(`/competitions/${competition.id}/judges/codes`).expect(200)).body as {
      id: string;
      token: string | null;
      tokenHash?: string;
      tokenSealed?: string;
    }[];
    expect(Object.fromEntries(codes.map((c) => [c.id, c.token]))).toEqual({ [sv.id]: sv.token, [e.id]: e.token });
    expect(codes[0]).not.toHaveProperty("tokenHash");
    expect(codes[0]).not.toHaveProperty("tokenSealed");
    await api(app, sv.token).get("/me").expect(200);

    // «Новый QR-код» меняет и то, что печатается.
    const fresh = (await admin.post(`/judges/${e.id}/token`).expect(201)).body as { token: string };
    codes = (await admin.get(`/competitions/${competition.id}/judges/codes`).expect(200)).body;
    expect(codes.find((c) => c.id === e.id)!.token).toBe(fresh.token);

    // Код, выданный до обновления, не восстановить: секретариат увидит, кому нужен новый.
    await app.get<Db>(DB).update(judges).set({ tokenSealed: null });
    codes = (await admin.get(`/competitions/${competition.id}/judges/codes`).expect(200)).body;
    expect(codes.map((c) => c.token)).toEqual([null, null]);
    expect((await admin.get(`/competitions/${competition.id}/judges`).expect(200)).body[0]).not.toHaveProperty("tokenSealed");
  });
});
