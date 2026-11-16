import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { PerformanceView, StandbyStatus } from "@ag/shared";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/setup";
import { ADMIN_TOKEN, api, startApp } from "./helpers";

const MAIN_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/ag_test";
const STANDBY_URL = MAIN_URL.replace(/\/[^/]+$/, "/ag_test_standby");
const STANDBY_TOKEN = "standby-admin-token-0123456789";

let primary: INestApplication;
let primaryUrl: string;
let standby: INestApplication;

/** Второй сервер со своей базой — как запасной ноутбук. */
async function startStandby(): Promise<INestApplication> {
  const root = new Client({ connectionString: MAIN_URL });
  await root.connect();
  await root.query("CREATE DATABASE ag_test_standby").catch(() => undefined);
  await root.end();
  const client = new Client({ connectionString: STANDBY_URL });
  await client.connect();
  await client.query("DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;");
  await client.end();
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.forConfig({ databaseUrl: STANDBY_URL, adminToken: STANDBY_TOKEN, port: 0 }),
    { logger: false },
  );
  configureApp(app);
  await app.listen(0, "127.0.0.1");
  return app;
}

beforeAll(async () => {
  ({ app: primary, url: primaryUrl } = await startApp());
  standby = await startStandby();
});

afterAll(async () => {
  await standby?.close();
  await primary?.close();
});

describe("запасной ноутбук", () => {
  it("забирает турниры с основного и продолжает с теми же QR-кодами", async () => {
    const main = api(primary, ADMIN_TOKEN);
    const spare = api(standby, STANDBY_TOKEN);
    const id = (await main.post("/competitions", { name: "Кубок", discipline: "WAG", trial: true }).expect(201)).body.id;
    const [gymnast] = (await main.post(`/competitions/${id}/gymnasts/import`, { rows: [{ bib: 1, lastName: "Иванова", firstName: "Анна" }] }).expect(201)).body;
    const tablet = (await main.post(`/competitions/${id}/judges`, { name: "Старшая", apparatus: "BB", role: "SUPERVISOR", seat: 1, enterAllMarks: true }).expect(201)).body.token;
    await main.post(`/competitions/${id}/judges`, { name: "D", apparatus: "BB", role: "D", seat: 1 }).expect(201);
    await main.post(`/competitions/${id}/judges`, { name: "E", apparatus: "BB", role: "E", seat: 1 }).expect(201);
    await main.post(`/competitions/${id}/manual-scores`, { gymnastId: gymnast.id, apparatus: "BB", d: 5, e: [1] }).expect(201);

    await spare.put("/standby", { primaryUrl: primaryUrl, token: "неверный-токен-0123456789" }).expect(400);
    const status = (await spare.put("/standby", { primaryUrl: `${primaryUrl}/judge/#/admin`, token: ADMIN_TOKEN }).expect(200)).body as StandbyStatus;
    expect(status.enabled).toBe(true);
    expect(status.primaryUrl).toBe(primaryUrl);
    expect(status.tournaments.map((t) => t.name)).toEqual(["Кубок"]);
    expect(status.lastError).toBeNull();
    await api(standby).get("/standby").expect(401);

    const result = (await spare.post("/standby/take-over").expect(201)).body;
    expect(result.loaded.map((l: { name: string }) => l.name)).toEqual(["Кубок"]);
    const perf = (await spare.get(`/competitions/${id}/performances?apparatus=BB`).expect(200)).body as PerformanceView[];
    expect(perf[0]!.score!.total).toBe(14);
    // Код судьи с основного ноутбука действует и на запасном.
    await api(standby, tablet).get("/me").expect(200);
    expect(((await spare.get("/standby").expect(200)).body as StandbyStatus).enabled).toBe(false);
    await spare.post("/standby/take-over").expect(400);
  });
});
