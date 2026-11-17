import { spawn, spawnSync } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readdir, rename, rm, stat, statfs, unlink, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { BadRequestException, Inject, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { APPARATUS_NAMES, type ReplayView, type SetVideoCamerasInput, type VideoCameraStatus, type VideoStatus } from "@ag/shared";
import { and, eq, gt, inArray, isNotNull, min } from "drizzle-orm";
import { APP_CONFIG, type AppConfig } from "../config";
import { DB, type Db } from "../db/db.module";
import { competitions, gymnasts, marks, performances, settings } from "../db/schema";
import { safeName } from "../protocols/zip";
import { clipWindow, cutArgs, maskUrl, pickSegments, recordedPast } from "./clips";
import { CameraRecorder, listSegments } from "./recorder";
import type { ZipFile } from "./zip-stream";

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
  private get clipsRoot(): string {
    return join(this.dir!, "clips");
  }

  // ——— Где лежат ролики ———
  // Папка турнира «Первенство города [fe057c59]», ролик «Бревно №11 Иванова Анна [14a902bf].mp4»,
  // широкий — «… [14a902bf шире].mp4». В квадратных скобках — начало номера турнира или выступления:
  // по нему программа находит файл, даже если участника или турнир потом переименовали.

  /** Папка роликов турнира; create — создать, если её ещё нет. */
  private async competitionDir(competitionId: string, create = false): Promise<string | null> {
    const tag = `[${shortId(competitionId)}]`;
    const found = (await readdir(this.clipsRoot).catch(() => [] as string[])).find((n) => n.endsWith(tag));
    if (found) return join(this.clipsRoot, found);
    if (!create) return null;
    const [c] = await this.db.select({ name: competitions.name }).from(competitions).where(eq(competitions.id, competitionId));
    const dir = join(this.clipsRoot, `${safeName(c?.name ?? "Турнир")} ${tag}`);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  /** Ролики турнира по началу номера выступления. */
  private async clipIndex(competitionId: string): Promise<{ dir: string | null; clips: Map<string, ClipFiles> }> {
    const dir = await this.competitionDir(competitionId);
    const clips = new Map<string, ClipFiles>();
    for (const name of dir ? await readdir(dir).catch(() => [] as string[]) : []) {
      const m = CLIP_RE.exec(name);
      if (!m) continue;
      const entry = clips.get(m[1]!) ?? {};
      if (m[3] === "fail") entry.fail = name;
      else if (m[2]) entry.wide = name;
      else entry.clip = name;
      clips.set(m[1]!, entry);
    }
    return { dir, clips };
  }

  private async clipFiles(competitionId: string, performanceId: string): Promise<{ dir: string | null; files: ClipFiles }> {
    const { dir, clips } = await this.clipIndex(competitionId);
    return { dir, files: clips.get(shortId(performanceId)) ?? {} };
  }

  /** Понятное имя ролика: снаряд, номер, фамилия, имя; прыжок и финал, если есть. */
  private async clipTitle(performanceId: string): Promise<string> {
    const [row] = await this.db
      .select({
        apparatus: performances.apparatus,
        attempt: performances.attempt,
        stage: performances.stage,
        bib: gymnasts.bib,
        lastName: gymnasts.lastName,
        firstName: gymnasts.firstName,
      })
      .from(performances)
      .innerJoin(gymnasts, eq(gymnasts.id, performances.gymnastId))
      .where(eq(performances.id, performanceId));
    if (!row) return "Выступление";
    return clipTitle(row);
  }

  // ——— Ролики ———

  async replay(performanceId: string): Promise<ReplayView> {
    const perf = await this.window(performanceId);
    const view: ReplayView = { performanceId, status: "none", url: null, wideUrl: null, message: null };
    if (!this.dir) return { ...view, message: "На этом снаряде нет камеры" };
    let { files } = await this.clipFiles(perf.competitionId, perf.id);
    if (!this.hasCamera(perf.apparatus) && !files.clip) return { ...view, message: "На этом снаряде нет камеры" };
    if (!files.clip && !files.fail) {
      if (!perf.approvedAt) return { ...view, status: "pending", message: "Ролик появится после утверждения оценки" };
      // Ещё не нарезан: пробуем сразу, не дожидаясь обхода.
      await this.build(perf, false);
      ({ files } = await this.clipFiles(perf.competitionId, perf.id));
    }
    if (files.clip) return { ...view, status: "ready", url: this.link(perf.id, false), wideUrl: files.wide ? this.link(perf.id, true) : null };
    if (files.fail) {
      const { dir } = await this.clipFiles(perf.competitionId, perf.id);
      const message = await readFile(join(dir!, files.fail), "utf8").catch(() => "Ролик не получился");
      return { ...view, status: "failed", message };
    }
    return { ...view, status: "pending", message: "Ролик ещё нарезается, через несколько секунд он будет готов" };
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
  private async build(perf: PerformanceWindow, wide: boolean, known?: ClipFiles): Promise<string | null> {
    if (!this.dir || !this.ffmpegOk || !perf.approvedAt) return null;
    const key = `${perf.id}${wide ? "-wide" : ""}`;
    if (this.building.has(key)) return null;
    const existing = known ?? (await this.clipFiles(perf.competitionId, perf.id)).files;
    // Широкий ролик режется заново при каждой просьбе: в нём может прибавиться записи после оценки.
    if (!wide && (existing.clip || existing.fail)) return null;
    const { from, to } = clipWindow(perf.createdAt.getTime(), perf.firstMarkAt?.getTime() ?? null, perf.approvedAt.getTime(), wide);
    const segments = await listSegments(this.liveDir(perf.apparatus));
    const recorder = this.recorders.get(perf.apparatus);
    const waiting = !wide && !recordedPast(segments, to) && Date.now() - to < GIVE_UP_MS && recorder?.status().state === "recording";
    if (waiting) return null;
    const pick = pickSegments(segments, from, to);
    const tag = `[${shortId(perf.id)}${wide ? " шире" : ""}]`;
    const fail = async (message: string) => {
      if (!wide) {
        const dir = (await this.competitionDir(perf.competitionId, true))!;
        await writeFile(join(dir, `${await this.clipTitle(perf.id)} ${tag}.fail`), message);
      }
      return message;
    };
    if (!pick) {
      const old = Date.now() - to > this.keepHours * 3600_000;
      return fail(old ? "Запись этого времени уже удалена" : "Камера не записывала во время выступления");
    }
    this.building.add(key);
    const dir = (await this.competitionDir(perf.competitionId, true))!;
    const out = join(dir, `${await this.clipTitle(perf.id)} ${tag}.mp4`);
    const tmp = join(dir, `.${shortId(perf.id)}${wide ? "-wide" : ""}.part`);
    const list = `${tmp}.txt`;
    try {
      const live = this.liveDir(perf.apparatus);
      await writeFile(list, pick.files.map((f) => `file '${join(live, f).replace(/'/g, "'\\''")}'`).join("\n") + "\n");
      await run(this.ffmpeg, cutArgs(list, pick.offset, pick.duration, tmp));
      // Прежний широкий ролик (возможно, под старым именем) заменяется новым.
      if (existing.wide && wide) await unlink(join(dir, existing.wide)).catch(() => undefined);
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
      const indexes = new Map<string, Map<string, ClipFiles>>();
      for (const row of rows) {
        const perf: PerformanceWindow = { ...row, firstMarkAt: row.firstMarkAt ? new Date(row.firstMarkAt) : null };
        let index = indexes.get(perf.competitionId);
        if (!index) {
          index = (await this.clipIndex(perf.competitionId)).clips;
          indexes.set(perf.competitionId, index);
        }
        const files = index.get(shortId(perf.id)) ?? {};
        if (files.clip || files.fail) continue;
        await this.build(perf, false, files);
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
    const dir = await this.competitionDir(competitionId);
    if (!dir) return { removed: 0 };
    const names = await readdir(dir).catch(() => [] as string[]);
    await rm(dir, { recursive: true, force: true });
    return { removed: names.filter((n) => n.endsWith(".mp4")).length };
  }

  /** Ролики турнира для архива: файлы с понятными именами, без номера в скобках. */
  async clipList(competitionId: string): Promise<{ folder: string; files: ZipFile[] }> {
    const dir = this.dir ? await this.competitionDir(competitionId) : null;
    const [c] = await this.db.select({ name: competitions.name }).from(competitions).where(eq(competitions.id, competitionId));
    if (!c) throw new NotFoundException("Соревнование не найдено");
    const folder = safeName(c.name);
    const files: ZipFile[] = [];
    const used = new Set<string>();
    for (const name of (dir ? await readdir(dir).catch(() => [] as string[]) : []).sort((a, b) => a.localeCompare(b, "ru"))) {
      const m = CLIP_RE.exec(name);
      if (!m || m[3] !== "mp4") continue;
      const st = await stat(join(dir!, name)).catch(() => null);
      if (!st) continue;
      let title = `${name.slice(0, m.index).trim()}${m[2] ? " (шире)" : ""}`;
      if (used.has(title)) title = `${title} ${m[1]}`;
      used.add(title);
      files.push({ name: `${folder}/${title}.mp4`, path: join(dir!, name), size: st.size });
    }
    return { folder, files };
  }

  /** Сколько роликов у турнира и сколько они занимают. */
  async clipsOf(competitionId: string): Promise<{ count: number; bytes: number }> {
    if (!this.dir) return { count: 0, bytes: 0 };
    const dir = await this.competitionDir(competitionId);
    const names = (dir ? await readdir(dir).catch(() => [] as string[]) : []).filter((n) => n.endsWith(".mp4"));
    let bytes = 0;
    for (const n of names) bytes += (await stat(join(dir!, n)).catch(() => ({ size: 0 }))).size;
    return { count: names.length, bytes };
  }

  // ——— Ссылки на ролики и архив ———

  private sign(subject: string, exp: number): string {
    return createHmac("sha256", this.secret).update(`${subject}:${exp}`).digest("base64url");
  }

  private checkSign(subject: string, exp: string, sig: string): void {
    const expires = Number(exp);
    if (!Number.isFinite(expires) || expires < Date.now()) throw new NotFoundException("Ссылка устарела: откройте её заново из секретариата");
    const want = Buffer.from(this.sign(subject, expires));
    const got = Buffer.from(String(sig ?? ""));
    if (want.length !== got.length || !timingSafeEqual(want, got)) throw new NotFoundException("Ссылка устарела: откройте её заново из секретариата");
  }

  private link(performanceId: string, wide: boolean): string {
    const exp = Date.now() + LINK_TTL_MS;
    const name = `${performanceId}${wide ? "-wide" : ""}`;
    return `/video/clips/${name}.mp4?exp=${exp}&sig=${this.sign(name, exp)}`;
  }

  /** Ссылка на архив роликов турнира: скачивается браузером напрямую, без токена в заголовке. */
  archiveLink(competitionId: string): { url: string } {
    const exp = Date.now() + LINK_TTL_MS;
    return { url: `/video/archive/${competitionId}.zip?exp=${exp}&sig=${this.sign(`zip:${competitionId}`, exp)}` };
  }

  checkArchive(competitionId: string, exp: string, sig: string): void {
    this.checkSign(`zip:${competitionId}`, exp, sig);
  }

  /** Файл ролика по подписанной ссылке: проигрыватель браузера не умеет передать токен. */
  async clipPath(name: string, exp: string, sig: string): Promise<{ path: string; title: string }> {
    const m = /^([0-9a-f-]{36})(-wide)?\.mp4$/.exec(name);
    if (!m || !this.dir) throw new NotFoundException("Ссылка на ролик устарела");
    this.checkSign(`${m[1]}${m[2] ?? ""}`, exp, sig);
    const [perf] = await this.db.select({ competitionId: performances.competitionId }).from(performances).where(eq(performances.id, m[1]!));
    if (!perf) throw new NotFoundException("Выступление не найдено");
    const { dir, files } = await this.clipFiles(perf.competitionId, m[1]!);
    const file = m[2] ? files.wide : files.clip;
    if (!dir || !file) throw new NotFoundException("Ролика нет");
    return { path: join(dir, file), title: file.replace(/ \[[^\]]+\]\.mp4$/, m[2] ? " (шире).mp4" : ".mp4") };
  }

  /** Кадр с камеры сейчас: проверить, что камера смотрит на снаряд. */
  async snapshot(apparatus: string): Promise<Buffer> {
    if (!this.dir || !this.ffmpegOk) throw new BadRequestException(this.unavailableReason() ?? "");
    const segments = await listSegments(this.liveDir(apparatus));
    // Последний кусок ещё пишется: начинаем с предпоследнего. Если у куска не нашлось
    // ключевого кадра ближе к концу, берём первый кадр куска.
    const candidates = [segments.at(-2), segments.at(-3), segments.at(-1)].filter((s): s is NonNullable<typeof s> => Boolean(s));
    if (candidates.length === 0) throw new NotFoundException("С камеры ещё нет записи: подождите 20 секунд после подключения");
    for (const seg of candidates) {
      for (const seek of [["-sseof", "-3"], []]) {
        const jpeg = await runToBuffer(this.ffmpeg, [
          "-hide_banner", "-loglevel", "error", "-nostdin",
          ...seek, "-i", join(this.liveDir(apparatus), seg.file),
          "-frames:v", "1", "-vf", "scale=640:-2", "-f", "image2", "-c:v", "mjpeg", "pipe:1",
        ]).catch(() => Buffer.alloc(0));
        if (jpeg.length > 0) return jpeg;
      }
    }
    throw new NotFoundException("Не удалось получить кадр: камера присылает видео, которое программа не читает (поставьте в камере H.264)");
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
      const knownTags = new Set([...known].map((id) => `[${shortId(id)}]`));
      for (const comp of await readdir(clipsRoot).catch(() => [] as string[])) {
        const dir = join(clipsRoot, comp);
        const tag = /\[[0-9a-f]{8}\]$/.exec(comp)?.[0];
        if (!tag || !knownTags.has(tag)) {
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

/** Начало номера: им помечены папки турниров и ролики. */
function shortId(id: string): string {
  return id.slice(0, 8);
}

/** «Бревно №11 Иванова Анна [14a902bf].mp4», «… [14a902bf шире].mp4», «… [14a902bf].fail». */
const CLIP_RE = /\s*\[([0-9a-f]{8})( шире)?\]\.(mp4|fail)$/;

interface ClipFiles {
  clip?: string;
  wide?: string;
  fail?: string;
}

/** Понятное имя ролика без номера в скобках. */
export function clipTitle(p: { apparatus: string; attempt: number; stage: string; bib: number; lastName: string; firstName: string }): string {
  const parts = [APPARATUS_NAMES[p.apparatus] ?? p.apparatus, `№${p.bib}`, p.lastName, p.firstName];
  if (p.attempt > 1) parts.push(`прыжок ${p.attempt}`);
  if (p.stage === "FINAL") parts.push("финал");
  return safeName(parts.join(" ")).replace(/[\[\]]/g, "");
}
