/**
 * Нарезка роликов выступлений из непрерывной записи камеры. Камера пишется кусками
 * по 10 секунд (файлы seg-ГГГГММДДTЧЧММСС.ts, время начала куска по UTC); ролик
 * выступления склеивается из нужных кусков без перекодирования.
 */

/** Запас до вызова участника: гимнаст иногда начинает сразу. */
export const CLIP_BEFORE_MS = 5_000;
/** Запас после первой оценки судьи: приземление и уход со снаряда. */
export const CLIP_AFTER_MS = 10_000;
/** Ролик не длиннее: если участника вызвали задолго до выхода, берём последние минуты перед оценкой. */
export const CLIP_MAX_MS = 5 * 60_000;
/** Сколько ещё добавляет «Шире» с каждой стороны. */
export const CLIP_WIDE_MS = 30_000;
/** Длина куска записи, секунды. */
export const SEGMENT_SECONDS = 10;

export interface Segment {
  file: string;
  /** Начало куска, мс от эпохи. */
  start: number;
  /** Конец куска: начало следующего или время последней записи в файл. */
  end: number;
}

const SEGMENT_RE = /^seg-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.ts$/;

/** Время начала куска по имени файла; не наш файл — null. */
export function segmentStart(name: string): number | null {
  const m = SEGMENT_RE.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number) as number[];
  return Date.UTC(y!, mo! - 1, d!, h!, mi!, s!);
}

/**
 * Куски записи по порядку. Конец куска — начало следующего, если тот начался
 * вплотную (иначе был обрыв связи и кусок кончился раньше); последний — по времени изменения файла.
 */
export function toSegments(files: readonly { name: string; mtimeMs: number }[]): Segment[] {
  const parsed = files
    .map((f) => ({ file: f.name, start: segmentStart(f.name), mtime: f.mtimeMs }))
    .filter((f): f is { file: string; start: number; mtime: number } => f.start !== null)
    .sort((a, b) => a.start - b.start);
  return parsed.map((f, i) => {
    const next = parsed[i + 1];
    const end = next && next.start - f.start <= SEGMENT_SECONDS * 3 * 1000 ? next.start : Math.max(f.start, f.mtime);
    return { file: f.file, start: f.start, end };
  });
}

/** Окно ролика выступления, мс от эпохи. */
export function clipWindow(
  calledAt: number,
  firstMarkAt: number | null,
  approvedAt: number,
  wide = false,
): { from: number; to: number } {
  const to = Math.max(calledAt, firstMarkAt ?? approvedAt) + CLIP_AFTER_MS;
  const from = Math.max(calledAt - CLIP_BEFORE_MS, to - CLIP_MAX_MS);
  return wide ? { from: from - CLIP_WIDE_MS, to: to + CLIP_WIDE_MS } : { from, to };
}

/** Куски, которые захватывают окно, и с какой секунды первого куска начинать. */
export function pickSegments(segments: readonly Segment[], from: number, to: number): { files: string[]; offset: number; duration: number } | null {
  const hit = segments.filter((s) => s.end > from && s.start < to);
  if (hit.length === 0) return null;
  const first = hit[0]!;
  const start = Math.max(from, first.start);
  const end = Math.min(to, hit[hit.length - 1]!.end);
  if (end - start < 1000) return null;
  return { files: hit.map((s) => s.file), offset: (start - first.start) / 1000, duration: (end - start) / 1000 };
}

/** Запись уже прошла конец окна: последний нужный кусок дописан. */
export function recordedPast(segments: readonly Segment[], to: number): boolean {
  return segments.some((s) => s.start >= to);
}

/** Аргументы ffmpeg для записи камеры кусками по 10 секунд, без звука и без перекодирования. */
export function recordArgs(url: string, dir: string): string[] {
  const input = /^rtsps?:\/\//i.test(url)
    ? ["-rtsp_transport", "tcp", "-timeout", "10000000", "-i", url]
    : /^(https?|rtmp|srt|udp):\/\//i.test(url)
      ? ["-i", url]
      : // Файл вместо камеры: для пробы и репетиции без камер, крутится по кругу.
        ["-re", "-stream_loop", "-1", "-i", url];
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    ...input,
    "-map",
    "0:v:0",
    "-c",
    "copy",
    "-an",
    "-f",
    "segment",
    "-segment_time",
    String(SEGMENT_SECONDS),
    "-segment_format",
    "mpegts",
    "-strftime",
    "1",
    `${dir}/seg-%Y%m%dT%H%M%S.ts`,
  ];
}

/** Аргументы ffmpeg для ролика: склейка кусков списком, начало с ближайшего ключевого кадра. */
export function cutArgs(listFile: string, offset: number, duration: number, out: string): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-ss",
    offset.toFixed(2),
    "-i",
    listFile,
    "-t",
    duration.toFixed(2),
    "-c",
    "copy",
    "-an",
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    out,
  ];
}

/** Пароль в адресе камеры не показываем целиком. */
export function maskUrl(url: string): string {
  return url.replace(/^([a-z]+:\/\/[^:/@]*:)([^@]*)@/i, (_, head: string) => `${head}***@`);
}
