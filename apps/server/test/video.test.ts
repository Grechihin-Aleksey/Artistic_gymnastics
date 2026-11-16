import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import type { PerformanceView, ReplayView, VideoStatus } from "@ag/shared";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clipWindow, maskUrl, pickSegments, recordedPast, segmentStart, toSegments } from "../src/video/clips";
import { ADMIN_TOKEN, api, startApp } from "./helpers";

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("нарезка: окна и куски", () => {
  const t = Date.UTC(2026, 10, 16, 12, 0, 0);
  it("читает время куска по имени", () => {
    expect(segmentStart("seg-20261116T120000.ts")).toBe(t);
    expect(segmentStart("list.txt")).toBeNull();
  });

  it("окно: от вызова −5 с до первой оценки +10 с, не длиннее 5 минут", () => {
    expect(clipWindow(t, t + 60_000, t + 90_000)).toEqual({ from: t - 5000, to: t + 70_000 });
    expect(clipWindow(t, null, t + 60_000)).toEqual({ from: t - 5000, to: t + 70_000 });
    const long = clipWindow(t, t + 20 * 60_000, t + 21 * 60_000);
    expect(long.to - long.from).toBe(5 * 60_000);
    expect(clipWindow(t, t + 60_000, t + 90_000, true)).toEqual({ from: t - 35_000, to: t + 100_000 });
  });

  it("берёт нужные куски и учитывает обрыв записи", () => {
    const files = [0, 10, 20, 30, 120].map((s) => ({
      name: `seg-20261116T12${String(Math.floor(s / 60)).padStart(2, "0")}${String(s % 60).padStart(2, "0")}.ts`,
      mtimeMs: t + (s + 10) * 1000,
    }));
    const segs = toSegments(files);
    expect(segs[3]!.end).toBe(t + 40_000); // после 30-го — обрыв до 120-го: конец по времени файла
    const pick = pickSegments(segs, t + 15_000, t + 35_000)!;
    expect(pick.files).toEqual(["seg-20261116T120010.ts", "seg-20261116T120020.ts", "seg-20261116T120030.ts"]);
    expect(pick.offset).toBe(5);
    expect(pick.duration).toBe(20);
    expect(pickSegments(segs, t + 50_000, t + 100_000)).toBeNull();
    expect(recordedPast(segs, t + 35_000)).toBe(true);
    expect(recordedPast(segs, t + 200_000)).toBe(false);
  });

  it("прячет пароль камеры", () => {
    expect(maskUrl("rtsp://admin:secret@192.168.0.10:554/stream1")).toBe("rtsp://admin:***@192.168.0.10:554/stream1");
    expect(maskUrl("rtsp://192.168.0.10/stream1")).toBe("rtsp://192.168.0.10/stream1");
  });
});

describe("без камер", () => {
  let app: INestApplication;
  beforeAll(async () => {
    ({ app } = await startApp());
  });
  afterAll(async () => {
    await app?.close();
  });

  it("программа работает как обычно, повторов просто нет", async () => {
    const admin = api(app, ADMIN_TOKEN);
    const status = (await admin.get("/video").expect(200)).body as VideoStatus;
    expect(status.available).toBe(false);
    expect(status.cameras).toEqual([]);
    await admin.put("/video/cameras", { cameras: [{ apparatus: "BB", url: "rtsp://cam/1" }] }).expect(400);
    await admin.put("/video/cameras", { cameras: [] }).expect(200);
    await api(app).get("/video").expect(401);

    const id = (await admin.post("/competitions", { name: "Кубок", discipline: "WAG" }).expect(201)).body.id;
    const [g] = (await admin.post(`/competitions/${id}/gymnasts/import`, { rows: [{ bib: 1, lastName: "Иванова", firstName: "Анна" }] }).expect(201)).body;
    const perf = (await admin.post(`/competitions/${id}/performances`, { gymnastId: g.id, apparatus: "BB" }).expect(201)).body as PerformanceView;
    const replay = (await admin.get(`/performances/${perf.id}/replay`).expect(200)).body as ReplayView;
    expect(replay.status).toBe("none");
    const ready = (await admin.get(`/competitions/${id}/readiness`).expect(200)).body as { checks: { group: string }[] };
    expect(ready.checks.some((c) => c.group === "Видеоповторы")).toBe(false);
  });
});

describe.skipIf(!hasFfmpeg)("камера на бревне", () => {
  let app: INestApplication;
  let dir: string;
  let source: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "ag-video-"));
    source = join(dir, "camera.ts");
    // «Камера» — файл с тестовой картинкой, ключевой кадр раз в секунду.
    execFileSync("ffmpeg", [
      "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10", "-t", "20",
      "-c:v", "libx264", "-g", "10", "-pix_fmt", "yuv420p", "-f", "mpegts", source,
    ]);
    ({ app } = await startApp({ videoDir: join(dir, "video"), videoKeepHours: 3, videoClipDays: 14, videoMinFreeGb: 0 }));
  });
  afterAll(async () => {
    await app?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("пишет камеру, нарезает ролик выступления и отдаёт его по подписанной ссылке", async () => {
    const admin = api(app, ADMIN_TOKEN);
    let status = (await admin.get("/video").expect(200)).body as VideoStatus;
    expect(status.available).toBe(true);
    status = (await admin.put("/video/cameras", { cameras: [{ apparatus: "BB", url: source }] }).expect(200)).body;
    expect(status.cameras.map((c) => c.apparatus)).toEqual(["BB"]);
    await admin.put("/video/cameras", { cameras: [{ apparatus: "BB", url: "a" }, { apparatus: "BB", url: "b" }] }).expect(400);

    const id = (await admin.post("/competitions", { name: "Кубок", discipline: "WAG" }).expect(201)).body.id;
    const [g] = (await admin.post(`/competitions/${id}/gymnasts/import`, { rows: [{ bib: 1, lastName: "Иванова", firstName: "Анна" }] }).expect(201)).body;
    const judge = (name: string, role: string) =>
      admin.post(`/competitions/${id}/judges`, { name, apparatus: "BB", role, seat: 1, enterAllMarks: role === "SUPERVISOR" }).expect(201);
    const tablet = (await judge("Кузнецова", "SUPERVISOR")).body.token as string;
    await judge("Орлова", "D");
    await judge("Волкова", "E");

    await new Promise((r) => setTimeout(r, 4000));
    const perf = (await api(app, tablet).post(`/competitions/${id}/performances`, { gymnastId: g.id, apparatus: "BB" }).expect(201)).body as PerformanceView;
    await new Promise((r) => setTimeout(r, 3000));
    await api(app, tablet).post(`/performances/${perf.id}/tablet-score`, { d: 4.5, e: [1.2] }).expect(201);

    // Пока камера не дописала кусок после конца окна, ролик ждёт.
    let replay = (await admin.get(`/performances/${perf.id}/replay`).expect(200)).body as ReplayView;
    expect(replay.status).toBe("pending");
    const deadline = Date.now() + 60_000;
    while (replay.status === "pending" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      replay = (await admin.get(`/performances/${perf.id}/replay`).expect(200)).body;
    }
    expect(replay.status).toBe("ready");
    const video = await request(app.getHttpServer()).get(replay.url!).expect(200);
    expect(video.headers["content-type"]).toContain("video/mp4");
    expect(video.body.length).toBeGreaterThan(1000);
    // От вызова −5 с до оценки +10 с; запись началась за 4 с до вызова — около 17 секунд.
    const clipFile = join(dir, "clip.mp4");
    writeFileSync(clipFile, video.body);
    const seconds = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", clipFile]).toString());
    expect(seconds).toBeGreaterThan(12);
    expect(seconds).toBeLessThan(22);
    await request(app.getHttpServer()).get(replay.url!.replace(/sig=[^&]+/, "sig=xxx")).expect(404);
    await request(app.getHttpServer()).get(replay.url!).set("Range", "bytes=0-99").expect(206);

    const wide = (await admin.post(`/performances/${perf.id}/replay/wide`).expect(201)).body as ReplayView;
    expect(wide.wideUrl).toBeTruthy();

    const snap = await admin.get("/video/cameras/BB/snapshot").expect(200);
    expect(snap.headers["content-type"]).toContain("image/jpeg");

    const ready = (await admin.get(`/competitions/${id}/readiness`).expect(200)).body as { checks: { group: string; status: string }[] };
    expect(ready.checks.find((c) => c.group === "Видеоповторы")?.status).toBe("ok");

    expect((await admin.get(`/competitions/${id}/replays`).expect(200)).body.count).toBe(2);
    expect((await admin.delete(`/competitions/${id}/replays`).expect(200)).body.removed).toBe(2);

    // Камеру сняли — запись остановлена.
    await admin.put("/video/cameras", { cameras: [] }).expect(200);
    expect(readdirSync(join(dir, "video", "live", "BB")).length).toBeGreaterThan(0);
  }, 120_000);
});
