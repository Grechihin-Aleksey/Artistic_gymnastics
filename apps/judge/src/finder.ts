import { useEffect, useRef, useState } from "react";
import type { RecoveredPerformance, SubmitMarkInput } from "@ag/shared";

/**
 * Поиск сервера по новому адресу. QR-код судьи держит адрес из цифр (192.168.1.23).
 * Если ноутбук секретариата получил другой адрес (переподключился к сети, его заменили
 * запасным), планшет со старым адресом сам перебирает адреса своей сети и ищет сервер,
 * который узнаёт его код входа. Найдя, досылает туда неотправленные и сохранённые
 * оценки и открывает страницу судьи уже с нового адреса.
 */

/** Сколько ждать без связи, прежде чем искать сервер по другим адресам. */
export const SEARCH_AFTER_MS = 40_000;
/** Как часто повторять поиск, пока сервер не найден. */
const SEARCH_EVERY_MS = 60_000;
const PROBE_TIMEOUT_MS = 1_500;
const CONCURRENCY = 32;

/** Адреса той же сети /24 с тем же портом, кроме текущего; для адреса не из цифр — пусто. */
export function candidateBases(origin: string): string[] {
  const m = /^(https?):\/\/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(:\d+)?$/.exec(origin);
  if (!m) return [];
  const [, scheme, a, b, c, d, port = ""] = m;
  const own = Number(d);
  const out: string[] = [];
  // Сначала ближайшие к прежнему адресу: роутер обычно выдаёт соседний.
  for (let step = 1; step < 254; step++) {
    for (const x of [own + step, own - step]) {
      if (x >= 1 && x <= 254) out.push(`${scheme}://${a}.${b}.${c}.${x}${port}`);
    }
  }
  return out;
}

type Fetch = typeof fetch;

/** Сервер, который принимает этот код судьи; null — не нашли. */
export async function findServer(
  bases: readonly string[],
  token: string,
  device: string,
  fetchImpl: Fetch = fetch,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<string | null> {
  let found: string | null = null;
  let next = 0;
  const probe = async (base: string) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetchImpl(`${base}/me`, {
        headers: { Authorization: `Bearer ${token}`, "X-Device": device },
        signal: controller.signal,
      });
      if (r.ok && found === null) found = base;
    } catch {
      // по этому адресу никого нет
    } finally {
      clearTimeout(timer);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, bases.length) }, async () => {
      while (found === null && next < bases.length) await probe(bases[next++]!);
    }),
  );
  return found;
}

/** Досылает оценки на найденный сервер; ошибки не мешают переходу — их подхватит сам сервер. */
export async function handOver(
  base: string,
  token: string,
  device: string,
  queued: readonly SubmitMarkInput[],
  journal: readonly RecoveredPerformance[],
  fetchImpl: Fetch = fetch,
): Promise<void> {
  const post = (path: string, body: unknown) =>
    fetchImpl(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-Device": device },
      body: JSON.stringify(body),
    }).catch(() => undefined);
  if (journal.length > 0) await post("/recovery", { performances: journal });
  for (const mark of queued) await post("/marks", mark);
}

export type FinderState = { stage: "idle" } | { stage: "searching" } | { stage: "found"; base: string };

/** Пока связи нет дольше SEARCH_AFTER_MS, ищет сервер по соседним адресам и переходит на него. */
export function useServerFinder(
  connected: boolean,
  token: string,
  device: string,
  pending: () => { queued: readonly SubmitMarkInput[]; journal: readonly RecoveredPerformance[] },
): FinderState {
  const [state, setState] = useState<FinderState>({ stage: "idle" });
  const latest = useRef(pending);
  latest.current = pending;

  useEffect(() => {
    if (connected) {
      setState({ stage: "idle" });
      return;
    }
    const bases = candidateBases(location.origin);
    if (bases.length === 0) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const search = async () => {
      if (cancelled) return;
      setState({ stage: "searching" });
      const base = await findServer(bases, token, device);
      if (cancelled) return;
      if (!base) {
        setState({ stage: "idle" });
        timer = setTimeout(() => void search(), SEARCH_EVERY_MS);
        return;
      }
      setState({ stage: "found", base });
      const { queued, journal } = latest.current();
      await handOver(base, token, device, queued, journal);
      if (cancelled) return;
      location.replace(`${base}/judge/#token=${encodeURIComponent(token)}&device=${encodeURIComponent(device)}`);
    };
    timer = setTimeout(() => void search(), SEARCH_AFTER_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [connected, token, device]);

  return state;
}
