import { spawn, spawnSync } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readdir, rename, rm, stat, statfs, unlink, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { BadRequestException, Inject, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { APPARATUS_NAMES, type ReplayView, type SetVideoCamerasInput, type VideoCameraStatus, type VideoStatus } from "@ag/shared";
import { and, eq, gt, inArray, isNotNull, min } from "drizzle-orm";
import { APP_CONFIG, type AppConfig } from "../config";
import { DB, type Db } from "../db/db.module";
import { competitions, marks, performances, settings } from "../db/schema";
import { clipWindow, cutArgs, maskUrl, pickSegments, recordedPast } from "./clips";
import { CameraRecorder, listSegments } from "./recorder";

const SETTING = "video.cameras";
/** Как часто нарезать готовые ролики. */
const SWEEP_MS = 10_000;
/** Как часто чистить старое и проверять место. */
const CLEANUP_MS = 60_000;
/** Камера не дописала кусок после конца окна за это время — режем, что есть. */
const GIVE_UP_MS = 60_000;
/** Ссылка на ролик живёт столько. */
const LINK_TTL_MS = 6 * 3600_000;
const GB = 1024 ** 3;

interface CameraConfig {
  apparatus: string;
  url: string;
}

interface PerformanceWindow {
  id: string;
  competitionId: string;
  apparatus: string;
  createdAt: Date;
  approvedAt: Date | null;
  firstMarkAt: Date | null;
}

/**
 * Видеоповторы: по одной IP-камере на снаряд, всё необязательно. Сервер пишет
 * поток каждой камеры кусками, после утверждения оценки нарезает ролик выступления
 * (от вызова участника до первой оценки судьи, с запасом) и отдаёт его секретариату
 * и главному судье. Без камер, без ffmpeg или при сбое камеры судейство идёт как обычно.
 */
@Injectable()
export class VideoService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("Video");
  private readonly recorders = new Map<string, CameraRecorder>();
  private readonly building = new Set<string>();
  private readonly secret = randomBytes(32);
  private cameras: CameraConfig[] = [];
  private ffmpegOk = false;
  private sweepTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private sweeping = false;
  private lowDisk = false;
  private disk: VideoStatus["disk"] = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private get dir(): string | undefined {
    return this.config.videoDir;
  }
  private get ffmpeg(): string {
    return this.config.ffmpegPath ?? "ffmpeg";
  }
  private get keepHours(): number {
    return this.config.videoKeepHours ?? 3;
  }
  private get clipDays(): number {
    return this.config.videoClipDays ?? 14;
  }
  private get minFreeGb(): number {
    return this.config.videoMinFreeGb ?? 5;
  }

  async onModuleInit(): Promise<void> {
    if (!this.dir) return;
    this.ffmpegOk = spawnSync(this.ffmpeg, ["-version"], { stdio: "ignore" }).status === 0;
    const [row] = await this.db.select().from(settings).where(eq(settings.key, SETTING));
    if (row) {
      try {
        this.cameras = JSON.parse(row.value) as CameraConfig[];
      } catch {
        this.cameras = [];
      }
    }
    if (!this.ffmpegOk) {
      if (this.cameras.length) this.log.warn("Камеры настроены, но ffmpeg не найден: повторы не пишутся");
      return;
    }
    await this.cleanup();
    this.startRecorders();
    this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_MS);
    this.sweepTimer.unref();
    this.cleanupTimer = setInterval(() => void this.cleanup(), CLEANUP_MS);
    this.cleanupTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    for (const r of this.recorders.values()) r.stop();
    this.recorders.clear();
  }

  private unavailableReason(): string | null {
    if (!this.dir) return "Не задана папка для записи (VIDEO_DIR). Обновите программу: в новой установке она задана.";
    if (!this.ffmpegOk) return "На сервере нет программы ffmpeg, без неё запись невозможна. Обновите программу.";
    return null;
  }

  status(): VideoStatus {
    const reason = this.unavailableReason();
    const now = Date.now();
    return {
      available: reason === null,
      reason,
      cameras: this.cameras.map((c): VideoCameraStatus => {
        const r = this.recorders.get(c.apparatus);
        const s = r?.status(now) ?? { apparatus: c.apparatus, state: "error" as const, message: reason, lastSegmentAt: null };
        return { ...s, url: maskUrl(c.url) };
      }),
      disk: this.disk,
      keepHours: this.keepHours,
      clipDays: this.clipDays,
      minFreeGb: this.minFreeGb,
    };
  }

  /** Камеры на снарядах с повторами: для «Готовности к старту». */
  hasCamera(apparatus: string): boolean {
    return this.cameras.some((c) => c.apparatus === apparatus);
  }

  async setCameras(input: SetVideoCamerasInput): Promise<VideoStatus> {
    const reason = this.unavailableReason();
    if (reason && input.cameras.length > 0) throw new BadRequestException(reason);
    const seen = new Set<string>();
    const next: CameraConfig[] = [];
    for (const c of input.cameras) {
      if (seen.has(c.apparatus)) throw new BadRequestException(`Две камеры на снаряде «${APPARATUS_NAMES[c.apparatus] ?? c.apparatus}»: оставьте одну`);
      seen.add(c.apparatus);
      // Пароль показывается звёздочками; если адрес не меняли, берём сохранённый.
      const old = this.cameras.find((o) => o.apparatus === c.apparatus);
      const url = c.url.includes("***@") && old && maskUrl(old.url) === c.url ? old.url : c.url;
      if (url.includes("***@")) throw new BadRequestException("Впишите пароль камеры в адрес вместо звёздочек");
      next.push({ apparatus: c.apparatus, url });
    }
    await this.db
      .insert(settings)
      .values({ key: SETTING, value: JSON.stringify(next) })
      .onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify(next) } });
    this.cameras = next;
    this.startRecorders();
    return this.status();
  }

  private startRecorders(): void {
    if (!this.dir || !this.ffmpegOk) return;
    for (const [apparatus, r] of this.recorders) {
      const want = this.cameras.find((c) => c.apparatus === apparatus);
      if (!want || want.url !== r.url) {
        r.stop();
        this.recorders.delete(apparatus);
      }
    }
    for (const c of this.cameras) {
      if (this.recorders.has(c.apparatus)) continue;
      const r = new CameraRecorder(c.apparatus, c.url, this.liveDir(c.apparatus), this.ffmpeg, (m) => this.log.warn(m));
      this.recorders.set(c.apparatus, r);
      r.start();
      if (this.lowDisk) r.pause();
    }
  }

  private liveDir(apparatus: string): string {
    return join(this.dir!, "live", apparatus);
  }
  private clipDir(competitionId: string): string {
    return join(this.dir!, "clips", competitionId);
  }
  private clipFile(competitionId: string, performanceId: string, wide: boolean): string {
    return join(this.clipDir(competitionId), `${performanceId}${wide ? "-wide" : ""}.mp4`);
  }

  // ——— Ролики ———

  async replay(performanceId: string): Promise<ReplayView> {
    const perf = await this.window(performanceId);
    const view: ReplayView = { performanceId, status: "none", url: null, wideUrl: null, message: null };
    const hasClip = this.dir ? await exists(this.clipFile(perf.competitionId, perf.id, false)) : false;
    if (!this.dir || (!this.hasCamera(perf.apparatus) && !hasClip)) {
      return { ...view, message: "На этом снаряде нет камеры" };
    }
    if (hasClip) {
      view.status = "ready";
      view.url = this.link(perf.id, false);
      if (await exists(this.clipFile(perf.competitionId, perf.id, true))) view.wideUrl = this.link(perf.id, true);
      return view;
    }
    const failed = await readFile(this.failFile(perf.competitionId, perf.id), "utf8").catch(() => null);
    if (failed !== null) return { ...view, status: "failed", message: failed };
    if (!perf.approvedAt) return { ...view, status: "pending", message: "Ролик появится после утверждения оценки" };
    // Ещё не нарезан: пробуем сразу, не дожидаясь обхода.
    await this.build(perf, false);
    return this.replayAfterBuild(perf);
  }

  /** Ролик пошире (±30 секунд): если на ролике не всё видно. */
  async replayWide(performanceId: string): Promise<ReplayView> {
    const perf = await this.window(performanceId);
    if (!perf.approvedAt) throw new BadRequestException("Оценка ещё не утверждена");
    if (!this.cameras.some((c) => c.apparatus === perf.apparatus)) throw new BadRequestException("На этом снаряде нет камеры");
    const message = await this.build(perf, true);
    if (message) throw new BadRequestException(message);
    return this.replay(performanceId);
  }

  private async replayAfterBuild(perf: PerformanceWindow): Promise<ReplayView> {
    const base: ReplayView = { performanceId: perf.id, status: "pending", url: null, wideUrl: null, message: "Ролик ещё нарезается, через несколько секунд он будет готов" };
    if (await exists(this.clipFile(perf.competitionId, perf.id, false))) return { ...base, status: "ready", url: this.link(perf.id, false), message: null };
    const failed = await readFile(this.failFile(perf.competitionId, perf.id), "utf8").catch(() => null);
    if (failed !== null) return { ...base, status: "failed", message: failed };
    return base;
  }

  private failFile(competitionId: string, performanceId: string): string {
    return join(this.clipDir(competitionId), `${performanceId}.fail`);
  }

  private async window(performanceId: string): Promise<PerformanceWindow> {
    const [row] = await this.db
      .select({
        id: performances.id,
        competitionId: performances.competitionId,
        apparatus: performances.apparatus,
        createdAt: performances.createdAt,
        approvedAt: performances.approvedAt,
        firstMarkAt: min(marks.createdAt),
      })
      .from(performances)
      .leftJoin(marks, eq(marks.performanceId, performances.id))
      .where(eq(performances.id, performanceId))
      .groupBy(performances.id);
    if (!row) throw new NotFoundException("Выступление не найдено");
    return { ...row, firstMarkAt: row.firstMarkAt ? new Date(row.firstMarkAt) : null };
  }

  /**
   * Нарезает ролик. Возвращает null, если ролик готов или ещё рано (камера не дописала
   * нужный кусок), и текст причины, если не получилось.
   */
  private async build(perf: PerformanceWindow, wide: boolean): Promise<string | null> {
    if (!this.dir || !this.ffmpegOk || !perf.approvedAt) return null;
    const key = `${perf.id}${wide ? "-wide" : ""}`;
    if (this.building.has(key)) return null;
    const out = this.clipFile(perf.competitionId, perf.id, wide);
    // Широкий ролик режется заново при каждой просьбе: в нём может прибавиться записи после оценки.
    if (!wide && (await exists(out))) return null;
    const { from, to } = clipWindow(perf.createdAt.getTime(), perf.firstMarkAt?.getTime() ?? null, perf.approvedAt.getTime(), wide);
    const segments = await listSegments(this.liveDir(perf.apparatus));
    const recorder = this.recorders.get(perf.apparatus);
    const waiting = !wide && !recordedPast(segments, to) && Date.now() - to < GIVE_UP_MS && recorder?.status().state === "recording";
    if (waiting) return null;
    const pick = pickSegments(segments, from, to);
    const fail = async (message: string) => {
      if (!wide) {
        await mkdir(this.clipDir(perf.competitionId), { recursive: true });
        await writeFile(this.failFile(perf.competitionId, perf.id), message);
      }
      return message;
    };
    if (!pick) {
      const old = Date.now() - to > this.keepHours * 3600_000;
      return fail(old ? "Запись этого времени уже удалена" : "Камера не записывала во время выступления");
    }
    this.building.add(key);
    const tmp = `${out}.part`;
    const list = `${out}.txt`;
    try {
      await mkdir(this.clipDir(perf.competitionId), { recursive: true });
      const dir = this.liveDir(perf.apparatus);
      await writeFile(list, pick.files.map((f) => `file '${join(dir, f).replace(/'/g, "'\\''")}'`).join("\n") + "\n");
      await run(this.ffmpeg, cutArgs(list, pick.offset, pick.duration, tmp));
      await rename(tmp, out);
      return null;
    } catch (e) {
      this.log.warn(`Ролик ${perf.id}: ${(e as Error).message}`);
      await unlink(tmp).catch(() => undefined);
      return fail("Не удалось нарезать ролик из записи");
    } finally {
      await unlink(list).catch(() => undefined);
      this.building.delete(key);
    }
  }

  /** Нарезает ролики всех недавно утверждённых выступлений на снарядах с камерами. */
  async sweep(): Promise<void> {
    if (this.sweeping || !this.dir || !this.ffmpegOk || this.cameras.length === 0) return;
    this.sweeping = true;
    try {
      const since = new Date(Date.now() - this.keepHours * 3600_000);
      const rows = await this.db
        .select({
          id: performances.id,
          competitionId: performances.competitionId,
          apparatus: performances.apparatus,
          createdAt: performances.createdAt,
          approvedAt: performances.approvedAt,
          firstMarkAt: min(marks.createdAt),
        })
        .from(performances)
        .leftJoin(marks, eq(marks.performanceId, performances.id))
        .where(
          and(
            isNotNull(performances.approvedAt),
            gt(performances.approvedAt, since),
            inArray(performances.apparatus, this.cameras.map((c) => c.apparatus) as never[]),
          ),
        )
        .groupBy(performances.id);
      for (const row of rows) {
        const perf: PerformanceWindow = { ...row, approvedAt: row.approvedAt!, firstMarkAt: row.firstMarkAt ? new Date(row.firstMarkAt) : null };
        if (await exists(this.failFile(perf.competitionId, perf.id))) continue;
        await this.build(perf, false);
      }
    } catch (e) {
      this.log.warn(`Нарезка роликов: ${(e as Error).message}`);
    } finally {
      this.sweeping = false;
    }
  }

  /** Удаляет ролики турнира: например, после соревнования, чтобы освободить место. */
  async removeClips(competitionId: string): Promise<{ removed: number }> {
    if (!this.dir) return { removed: 0 };
    const dir = this.clipDir(competitionId);
    const names = await readdir(dir).catch(() => [] as string[]);
    await rm(dir, { recursive: true, force: true });
    return { removed: names.filter((n) => n.endsWith(".mp4")).length };
  }

  /** Сколько роликов у турнира и сколько они занимают. */
  async clipsOf(competitionId: string): Promise<{ count: number; bytes: number }> {
    if (!this.dir) return { count: 0, bytes: 0 };
    const dir = this.clipDir(competitionId);
    const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".mp4"));
    let bytes = 0;
    for (const n of names) bytes += (await stat(join(dir, n)).catch(() => ({ size: 0 }))).size;
    return { count: names.length, bytes };
  }

  // ——— Ссылки на ролики ———

  private sign(performanceId: string, wide: boolean, exp: number): string {
    return createHmac("sha256", this.secret).update(`${performanceId}:${wide ? 1 : 0}:${exp}`).digest("base64url");
  }

  private link(performanceId: string, wide: boolean): string {
    const exp = Date.now() + LINK_TTL_MS;
    return `/video/clips/${performanceId}${wide ? "-wide" : ""}.mp4?exp=${exp}&sig=${this.sign(performanceId, wide, exp)}`;
  }

  /** Файл ролика по подписанной ссылке: проигрыватель браузера не умеет передать токен. */
  async clipPath(name: string, exp: string, sig: string): Promise<string> {
    const m = /^([0-9a-f-]{36})(-wide)?\.mp4$/.exec(name);
    const expires = Number(exp);
    if (!m || !this.dir || !Number.isFinite(expires) || expires < Date.now()) throw new NotFoundException("Ссылка на ролик устарела");
    const wide = Boolean(m[2]);
    const want = Buffer.from(this.sign(m[1]!, wide, expires));
    const got = Buffer.from(String(sig));
    if (want.length !== got.length || !timingSafeEqual(want, got)) throw new NotFoundException("Ссылка на ролик устарела");
    const [perf] = await this.db.select({ competitionId: performances.competitionId }).from(performances).where(eq(performances.id, m[1]!));
    if (!perf) throw new NotFoundException("Выступление не найдено");
    const file = this.clipFile(perf.competitionId, m[1]!, wide);
    if (!(await exists(file))) throw new NotFoundException("Ролика нет");
    return file;
  }

  /** Кадр с камеры сейчас: проверить, что камера смотрит на снаряд. */
  async snapshot(apparatus: string): Promise<Buffer> {
    if (!this.dir || !this.ffmpegOk) throw new BadRequestException(this.unavailableReason() ?? "");
    const segments = await listSegments(this.liveDir(apparatus));
    // Последний кусок ещё пишется; берём предпоследний, а если он один — последний.
    const seg = segments.at(-2) ?? segments.at(-1);
    if (!seg) throw new NotFoundException("С камеры ещё нет записи: подождите 20 секунд после подключения");
    return runToBuffer(this.ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-nostdin",
      "-sseof", "-1", "-i", join(this.liveDir(apparatus), seg.file),
      "-frames:v", "1", "-vf", "scale=640:-2", "-f", "image2", "-c:v", "mjpeg", "pipe:1",
    ]);
  }

  // ——— Место на диске ———

  async cleanup(): Promise<void> {
    if (!this.dir) return;
    try {
      await mkdir(this.dir, { recursive: true });
      const now = Date.now();
      // Непрерывная запись: старше keepHours не нужна, ролики из неё уже нарезаны.
      const liveRoot = join(this.dir, "live");
      const all: { path: string; start: number }[] = [];
      for (const app of await readdir(liveRoot).catch(() => [] as string[])) {
        for (const s of await listSegments(join(liveRoot, app))) all.push({ path: join(liveRoot, app, s.file), start: s.start });
      }
      for (const s of all) if (now - s.start > this.keepHours * 3600_000) await unlink(s.path).catch(() => undefined);
      // Ролики: старше clipDays и ролики удалённых турниров.
      const clipsRoot = join(this.dir, "clips");
      const known = new Set((await this.db.select({ id: competitions.id }).from(competitions)).map((c) => c.id));
      for (const comp of await readdir(clipsRoot).catch(() => [] as string[])) {
        const dir = join(clipsRoot, comp);
        if (!known.has(comp)) {
          await rm(dir, { recursive: true, force: true });
          continue;
        }
        for (const n of await readdir(dir).catch(() => [] as string[])) {
          const st = await stat(join(dir, n)).catch(() => null);
          if (st && now - st.mtimeMs > this.clipDays * 86_400_000) await unlink(join(dir, n)).catch(() => undefined);
        }
      }
      // Мало места: сначала удаляем самую старую непрерывную запись (кроме последних 15 минут).
      let fs = await statfs(this.dir);
      let free = fs.bavail * fs.bsize;
      const minFree = this.minFreeGb * GB;
      if (free < minFree) {
        const old = all.filter((s) => now - s.start > 15 * 60_000).sort((a, b) => a.start - b.start);
        for (const s of old) {
          if (free >= minFree) break;
          const size = (await stat(s.path).catch(() => ({ size: 0 }))).size;
          await unlink(s.path).catch(() => undefined);
          free += size;
        }
        fs = await statfs(this.dir);
        free = fs.bavail * fs.bsize;
      }
      // Всё равно мало — останавливаем запись, пока место не появится (с запасом в 1 ГБ).
      if (!this.lowDisk && free < minFree) {
        this.lowDisk = true;
        this.log.warn("Мало места на диске: запись камер остановлена");
        for (const r of this.recorders.values()) r.pause();
      } else if (this.lowDisk && free > minFree + GB) {
        this.lowDisk = false;
        for (const r of this.recorders.values()) r.resume();
      }
      this.disk = { freeBytes: free, totalBytes: fs.blocks * fs.bsize, videoBytes: await dirSize(this.dir) };
    } catch (e) {
      this.log.warn(`Очистка видео: ${(e as Error).message}`);
    }
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(p);
    else total += (await stat(p).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

function run(cmd: string, args: string[]): Promise<void> {
  return runToBuffer(cmd, args).then(() => undefined);
}

function runToBuffer(cmd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => (err = (err + b.toString()).slice(-1000)));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(err.trim() || `ffmpeg завершился с кодом ${code}`));
    });
  });
}
