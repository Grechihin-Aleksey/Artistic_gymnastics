import { generateKeyPairSync, sign } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB, type Db } from "../src/db/db.module";
import { eq } from "drizzle-orm";
import { settings } from "../src/db/schema";
import { daysLeft, readLicense } from "../src/license/license";
import { ADMIN_TOKEN, api, startApp } from "./helpers";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC = publicKey.export({ type: "spki", format: "pem" }).toString();

function issue(until: string, org = "СШОР №1", key = privateKey): string {
  const data = Buffer.from(JSON.stringify({ id: "test01", org, until, issued: "2026-01-01" })).toString("base64url");
  return `AG1.${data}.${sign(null, Buffer.from(`AG1.${data}`), key).toString("base64url")}`;
}

let app: INestApplication;
let admin: ReturnType<typeof api>;

beforeAll(async () => {
  ({ app } = await startApp({ licenseRequired: true, licensePublicKey: PUBLIC }));
  admin = api(app, ADMIN_TOKEN);
});

afterAll(async () => {
  await app?.close();
});

describe("ключ лицензии", () => {
  it("принимает только ключ с верной подписью", () => {
    expect(readLicense(issue("2030-01-01"), PUBLIC)).toMatchObject({ org: "СШОР №1", until: "2030-01-01" });
    const other = generateKeyPairSync("ed25519").privateKey;
    expect(readLicense(issue("2030-01-01", "Чужой", other), PUBLIC)).toBeNull();
    const [prefix, , signature] = issue("2030-01-01").split(".");
    const forged = Buffer.from(JSON.stringify({ id: "x", org: "СШОР №1", until: "2099-01-01" })).toString("base64url");
    expect(readLicense(`${prefix}.${forged}.${signature}`, PUBLIC)).toBeNull();
    expect(readLicense("мусор", PUBLIC)).toBeNull();
  });

  it("считает дни включительно", () => {
    expect(daysLeft("2026-11-16", "2026-11-16")).toBe(1);
    expect(daysLeft("2026-11-15", "2026-11-16")).toBe(0);
    expect(daysLeft("2026-12-16", "2026-11-16")).toBe(31);
  });
});

describe("без лицензии", () => {
  it("разрешает только пробный турнир", async () => {
    expect((await admin.get("/license").expect(200)).body).toMatchObject({ state: "missing", required: true });
    const denied = await admin.post("/competitions", { name: "Кубок", discipline: "WAG" }).expect(403);
    expect(denied.body.message).toContain("пробный турнир");
    await admin.post("/competitions", { name: "Репетиция", discipline: "WAG", trial: true }).expect(201);
  });

  it("не сохраняет неверный и истёкший ключ", async () => {
    await admin.put("/license", { key: "AG1.abc.def" }).expect(400);
    const expired = await admin.put("/license", { key: issue("2020-01-01") }).expect(400);
    expect(expired.body.message).toContain("01.01.2020");
    await api(app).put("/license", { key: issue("2030-01-01") }).expect(401);
  });

  it("с действующим ключом создаёт турниры, а после конца срока снова только пробные", async () => {
    const saved = (await admin.put("/license", { key: issue("2099-12-31") }).expect(200)).body;
    expect(saved).toMatchObject({ state: "active", license: { org: "СШОР №1", until: "2099-12-31" } });
    const created = (await admin.post("/competitions", { name: "Кубок", discipline: "WAG" }).expect(201)).body as { id: string };

    // Перевод часов назад не помогает: сервер помнит самое позднее время, которое видел.
    const db = app.get<Db>(DB);
    await db.update(settings).set({ value: "2100-06-01T00:00:00.000Z" }).where(eq(settings.key, "license_clock"));
    expect((await admin.get("/license").expect(200)).body).toMatchObject({ state: "expired" });
    await admin.post("/competitions", { name: "Ещё кубок", discipline: "WAG" }).expect(403);

    // Идущий турнир лицензия не останавливает.
    await admin.post(`/competitions/${created.id}/gymnasts`, { bib: 1, lastName: "Абрамова", firstName: "Анна" }).expect(201);
    const file = (await admin.get(`/competitions/${created.id}/export`).expect(200)).body;
    await admin.delete(`/competitions/${created.id}`).expect(204);
    await admin.post("/competitions/import", file).expect(403);
  });
});
