import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { CLEANUP_KEEP_DUMPS, type CleanupStatus } from "@ag/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CleanupService } from "../src/cleanup/cleanup.service";
import { ADMIN_TOKEN, api, startApp } from "./helpers";

let app: INestApplication;
let admin: ReturnType<typeof api>;
let backupDir: string;

const pad = (n: number) => String(n).padStart(2, "0");
const dumpName = (t: Date) =>
  `gymnastics-${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}.dump`;

/** Турнир закончился daysAgo дней назад: копии каждые 5 минут за последние сутки турнира. */
async function tournamentDumps(daysAgo: number, count: number) {
  const end = Date.now() - daysAgo * 24 * 3600_000;
  for (let i = 0; i < count; i++) await writeFile(join(backupDir, dumpName(new Date(end - i * 5 * 60_000))), "x".repeat(1000));
}
const dumpsLeft = async () => (await readdir(backupDir)).filter((n) => n.endsWith(".dump")).length;

beforeAll(async () => {
  backupDir = await mkdtemp(join(tmpdir(), "ag-cleanup-"));
  ({ app } = await startApp({ backupDir }));
  admin = api(app, ADMIN_TOKEN);
});

afterAll(async () => {
  await app?.close();
});

describe("очистка после турниров", () => {
  it("по умолчанию 30 дней; свежий турнир не трогается", async () => {
    await tournamentDumps(2, 40);
    await writeFile(join(backupDir, "restore-check.json"), "{}");
    const status = (await admin.get("/cleanup").expect(200)).body as CleanupStatus;
    expect(status.enabled).toBe(true);
    expect(status.days).toBe(30);
    expect(status.dumps).toEqual({ count: 40, bytes: 40_000 });
    expect(status.removable.count).toBe(40 - CLEANUP_KEEP_DUMPS);
    const due = Date.parse(status.dueAt!) - Date.parse(status.lastChangeAt!);
    expect(Math.round(due / (24 * 3600_000))).toBe(30);

    await app.get(CleanupService).auto();
    expect(await dumpsLeft()).toBe(40);
    await api(app).get("/cleanup").expect(401);
  });

  it("срок прошёл — остаются только свежие копии; файлы турниров и проверка не трогаются", async () => {
    await admin.put("/cleanup", { days: 1 }).expect(200);
    const status = await app.get(CleanupService).auto();
    expect(await dumpsLeft()).toBe(CLEANUP_KEEP_DUMPS);
    expect(status.lastRun).toMatchObject({ deleted: 40 - CLEANUP_KEEP_DUMPS, freedBytes: (40 - CLEANUP_KEEP_DUMPS) * 1000, auto: true });
    expect(status.removable.count).toBe(0);
    expect(status.dueAt).toBeNull();
    expect(await readdir(backupDir)).toContain("restore-check.json");
  });

  it("0 — автоудаление выключено, но кнопка «Очистить сейчас» работает", async () => {
    await tournamentDumps(5, 30);
    await admin.put("/cleanup", { days: 0 }).expect(200);
    const off = await app.get(CleanupService).auto();
    expect(off.dueAt).toBeNull();
    expect(await dumpsLeft()).toBeGreaterThan(CLEANUP_KEEP_DUMPS);

    const after = (await admin.post("/cleanup/run").expect(200)).body as CleanupStatus;
    expect(after.lastRun!.auto).toBe(false);
    expect(await dumpsLeft()).toBe(CLEANUP_KEEP_DUMPS);
    await admin.put("/cleanup", { days: -1 }).expect(400);
  });
});
