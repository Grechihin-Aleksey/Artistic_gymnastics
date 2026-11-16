import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { VideoCameraStatus } from "@ag/shared";
import { recordArgs, toSegments, type Segment } from "./clips";

/** Нет нового куска дольше этого — камера зависла, перезапускаем запись. */
const STALL_MS = 30_000;
/** Пауза перед переподключением растёт до этого. */
const MAX_BACKOFF_MS = 30_000;

/**
 * Запись одной камеры: ffmpeg пишет поток кусками в свою папку. Если камера
 * пропала или зависла, запись перезапускается сама; на судейство это не влияет.
 */
export class CameraRecorder {
  private child: ChildProcess | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private backoff = 2_000;
  private startedAt = 0;
  private lastError: string | null = null;
  private lastSegmentAt: number | null = null;
  private stopped = true;
  /** Остановлено из-за места на диске: не перезапускать, пока место не появится. */
  private paused = false;

  constructor(
    readonly apparatus: string,
    readonly url: string,
    readonly dir: string,
    private readonly ffmpeg: string,
    private readonly log: (message: string) => void,
  ) {}

  start(): void {
    this.stopped = false;
    this.paused = false;
    void this.spawn();
    this.watchdog = setInterval(() => void this.check(), 5_000);
    this.watchdog.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.kill();
  }

  /** Мало места: перестать писать, но помнить, что камера настроена. */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.kill();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    void this.spawn();
  }

  status(now = Date.now()): Omit<VideoCameraStatus, "url"> {
    const fresh = this.lastSegmentAt !== null && now - this.lastSegmentAt < STALL_MS;
    const state: VideoCameraStatus["state"] = this.paused
      ? "stopped"
      : this.child && fresh
        ? "recording"
        : this.lastError && !this.child
          ? "error"
          : "connecting";
    return {
      apparatus: this.apparatus,
      state,
      message: this.paused ? "Мало места на диске: запись остановлена" : state === "recording" ? null : this.lastError,
      lastSegmentAt: this.lastSegmentAt ? new Date(this.lastSegmentAt).toISOString() : null,
    };
  }

  async segments(): Promise<Segment[]> {
    return listSegments(this.dir);
  }

  private async spawn(): Promise<void> {
    if (this.stopped || this.paused || this.child) return;
    await mkdir(this.dir, { recursive: true });
    if (this.stopped || this.paused || this.child) return;
    this.startedAt = Date.now();
    // Время в именах кусков — по UTC, чтобы не зависеть от часового пояса ноутбука.
    const child = spawn(this.ffmpeg, recordArgs(this.url, this.dir), {
      env: { ...process.env, TZ: "UTC" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.child = child;
    let tail = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      tail = (tail + chunk.toString()).slice(-2000);
    });
    child.on("error", (e) => {
      this.lastError = `Не удалось запустить ffmpeg: ${e.message}`;
    });
    child.on("close", () => {
      if (this.child === child) this.child = null;
      const line = tail.trim().split("\n").pop()?.trim();
      if (line) this.lastError = humanError(line);
      else if (!this.lastError) this.lastError = "Камера не отвечает";
      this.scheduleRestart();
    });
  }

  private scheduleRestart(): void {
    if (this.stopped || this.paused || this.restartTimer) return;
    // Работала долго — значит, это обрыв, переподключаемся быстро.
    if (Date.now() - this.startedAt > 60_000) this.backoff = 2_000;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.spawn();
    }, this.backoff);
    this.restartTimer.unref();
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
  }

  private kill(): void {
    const child = this.child;
    this.child = null;
    child?.kill("SIGKILL");
  }

  private async check(): Promise<void> {
    if (this.stopped) return;
    const last = (await this.segments().catch(() => [])).at(-1);
    if (last) this.lastSegmentAt = Math.max(this.lastSegmentAt ?? 0, last.end);
    const now = Date.now();
    if (this.child && now - this.startedAt > STALL_MS && (this.lastSegmentAt === null || now - this.lastSegmentAt > STALL_MS)) {
      this.lastError = "Камера перестала присылать видео, переподключаемся";
      this.log(`${this.apparatus}: ${this.lastError}`);
      this.kill();
      this.scheduleRestart();
    }
    if (this.child && this.lastSegmentAt && now - this.lastSegmentAt < STALL_MS) this.lastError = null;
  }
}

export async function listSegments(dir: string): Promise<Segment[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files = await Promise.all(
    names.map(async (name) => {
      try {
        return { name, mtimeMs: (await stat(join(dir, name))).mtimeMs };
      } catch {
        return null;
      }
    }),
  );
  return toSegments(files.filter((f): f is { name: string; mtimeMs: number } => f !== null));
}

/** Сообщение ffmpeg понятными словами для секретаря. */
export function humanError(line: string): string {
  if (/401|Unauthorized/i.test(line)) return "Камера не пускает: проверьте логин и пароль в адресе";
  if (/404|Not Found/i.test(line)) return "Камера не нашла поток: проверьте путь после адреса (например /stream1)";
  if (/Connection refused/i.test(line)) return "Камера отказала в подключении: проверьте порт (обычно 554)";
  if (/timed out|timeout|No route to host|Network is unreachable/i.test(line)) return "Камера не отвечает: проверьте питание, Wi-Fi и адрес";
  if (/No such file/i.test(line)) return "Файл не найден";
  return line.slice(0, 200);
}
