import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import type { UpdateStatus } from "@ag/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newerVersion } from "../src/updates/updates.service";
import { ADMIN_TOKEN, api, startApp } from "./helpers";

let app: INestApplication;
let github: Server;
let published: unknown = { version: "2026.12.1", notes: ["Исправлен перенос строк в грамотах"] };
let auth: string | undefined;

beforeAll(async () => {
  github = createServer((req, res) => {
    auth = req.headers.authorization;
    if (published === null) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(published));
  });
  await new Promise<void>((resolve) => github.listen(0, "127.0.0.1", resolve));
  const dir = mkdtempSync(join(tmpdir(), "ag-version-"));
  const versionFile = join(dir, "version.json");
  writeFileSync(versionFile, JSON.stringify({ version: "2026.11.16", notes: [] }));
  ({ app } = await startApp({
    updateUrl: `http://127.0.0.1:${(github.address() as AddressInfo).port}/version.json`,
    githubToken: "ghp_test",
    versionFile,
  }));
});

afterAll(async () => {
  await app?.close();
  github?.close();
});

describe("сообщение о новой версии", () => {
  it("сравнивает версии по числам", () => {
    expect(newerVersion("2026.11.20", "2026.11.16")).toBe(true);
    expect(newerVersion("2026.12.1", "2026.11.30")).toBe(true);
    expect(newerVersion("2026.11.16", "2026.11.16")).toBe(false);
    expect(newerVersion("2026.11.9", "2026.11.16")).toBe(false);
  });

  it("показывает секретариату новую версию и что в ней нового", async () => {
    const admin = api(app, ADMIN_TOKEN);
    await api(app).get("/updates").expect(401);
    const before = (await admin.get("/updates").expect(200)).body as UpdateStatus;
    expect(before).toMatchObject({ current: "2026.11.16", latest: null, available: false, checkedAt: null });

    const after = (await admin.post("/updates/check").expect(201)).body as UpdateStatus;
    expect(after).toMatchObject({ latest: "2026.12.1", available: true, notes: ["Исправлен перенос строк в грамотах"] });
    expect(after.checkedAt).not.toBeNull();
    expect(auth).toBe("Bearer ghp_test");
  });

  it("без интернета или с той же версией молчит, прошлый ответ не теряет", async () => {
    const admin = api(app, ADMIN_TOKEN);
    published = null;
    expect(((await admin.post("/updates/check").expect(201)).body as UpdateStatus).latest).toBe("2026.12.1");
    published = { version: "2026.11.16", notes: ["то же самое"] };
    const same = (await admin.post("/updates/check").expect(201)).body as UpdateStatus;
    expect(same).toMatchObject({ available: false, notes: [] });
    published = { version: "не версия" };
    expect(((await admin.post("/updates/check").expect(201)).body as UpdateStatus).latest).toBe("2026.11.16");
  });
});
