import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Client } from "pg";
import request from "supertest";
import { AppModule } from "../src/app.module";
import type { AppConfig } from "../src/config";

export const ADMIN_TOKEN = "test-admin-token-0123456789";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/ag_test";

/** Чистая база и запущенный сервер на свободном порту. */
export async function startApp(extra: Partial<AppConfig> = {}): Promise<{ app: INestApplication; url: string }> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  await client.query("DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;");
  await client.end();

  const app = await NestFactory.create(
    AppModule.forConfig({ databaseUrl: DATABASE_URL, adminToken: ADMIN_TOKEN, port: 0, ...extra }),
    { logger: false },
  );
  await app.listen(0, "127.0.0.1");
  return { app, url: await app.getUrl() };
}

export function api(app: INestApplication, token?: string) {
  const server = app.getHttpServer();
  const auth = (r: request.Test) => (token ? r.set("Authorization", `Bearer ${token}`) : r);
  return {
    get: (path: string) => auth(request(server).get(path)),
    post: (path: string, body?: object) => auth(request(server).post(path)).send(body ?? {}),
  };
}
