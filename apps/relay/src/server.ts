import { timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { RELAY_EVENTS, type BoardSnapshot, type PerformanceView } from "@ag/shared";
import { z } from "zod";
import type { RelayConfig } from "./config.js";
import { SnapshotStore } from "./store.js";

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const HEARTBEAT_MS = 25_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Проверяем только то, на что опирается сам ретранслятор; таблицы он передаёт как есть.
const ingestSchema = z.object({
  snapshot: z.looseObject({
    competition: z.looseObject({ id: z.string(), name: z.string(), discipline: z.string() }),
    live: z.array(z.unknown()),
    allAround: z.array(z.unknown()),
    teams: z.array(z.unknown()),
    apparatus: z.record(z.string(), z.array(z.unknown())),
    generatedAt: z.string(),
  }),
  approved: z.array(z.looseObject({ id: z.string() })).default([]),
});

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Relay {
  server: Server;
  store: SnapshotStore;
  close(): Promise<void>;
}

/**
 * Облачный ретранслятор: принимает снимки результатов от сервера в зале
 * и раздаёт их сайту. Зрители никогда не обращаются к залу напрямую.
 */
export async function createRelay(config: RelayConfig): Promise<Relay> {
  const store = new SnapshotStore(config.dataDir);
  await store.load();
  const viewers = new Map<string, Set<ServerResponse>>();
  const expectedAuth = Buffer.from(`Bearer ${config.token}`);

  const broadcast = (competitionId: string, event: string, data: unknown) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of viewers.get(competitionId) ?? []) res.write(frame);
  };

  const heartbeat = setInterval(() => {
    for (const set of viewers.values()) for (const res of set) res.write(": ping\n\n");
  }, HEARTBEAT_MS);
  heartbeat.unref();

  const authorized = (req: IncomingMessage) => {
    const given = Buffer.from(req.headers.authorization ?? "");
    return given.length === expectedAuth.length && timingSafeEqual(given, expectedAuth);
  };

  async function ingest(req: IncomingMessage, res: ServerResponse, id: string) {
    if (!authorized(req)) throw new HttpError(401, "Неверный токен");
    const parsed = ingestSchema.safeParse(JSON.parse(await readBody(req)));
    if (!parsed.success) throw new HttpError(400, "Неверный формат снимка");
    const snapshot = parsed.data.snapshot as unknown as BoardSnapshot;
    if (snapshot.competition.id !== id) throw new HttpError(400, "Снимок другого соревнования");
    const previous = store.get(id);
    // Запоздавший снимок (повтор после обрыва связи) не должен затирать более свежий.
    if (previous && previous.generatedAt > snapshot.generatedAt) {
      return json(res, 200, { ok: true, stale: true });
    }
    await store.put(snapshot);
    broadcast(id, RELAY_EVENTS.snapshot, snapshot);
    for (const view of parsed.data.approved as unknown as PerformanceView[]) {
      broadcast(id, RELAY_EVENTS.approved, view);
    }
    json(res, 200, { ok: true });
  }

  function stream(req: IncomingMessage, res: ServerResponse, id: string) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "access-control-allow-origin": "*",
    });
    res.write("retry: 5000\n\n");
    const snapshot = store.get(id);
    if (snapshot) res.write(`event: ${RELAY_EVENTS.snapshot}\ndata: ${JSON.stringify(snapshot)}\n\n`);
    let set = viewers.get(id);
    if (!set) viewers.set(id, (set = new Set()));
    set.add(res);
    req.on("close", () => {
      set.delete(res);
      if (set.size === 0) viewers.delete(id);
    });
  }

  async function serveStatic(res: ServerResponse, root: string | undefined, path: string, fallback?: string) {
    if (!root) throw new HttpError(404, "Не найдено");
    root = normalize(root);
    const file = normalize(join(root, decodeURIComponent(path)));
    if (file !== root && !file.startsWith(root.endsWith(sep) ? root : root + sep)) {
      throw new HttpError(404, "Не найдено");
    }
    let target = file;
    const info = await stat(target).catch(() => null);
    if (!info?.isFile()) {
      if (!fallback) throw new HttpError(404, "Не найдено");
      target = join(root, fallback);
      if (!(await stat(target).catch(() => null))?.isFile()) throw new HttpError(404, "Не найдено");
    }
    const hashed = target.includes(`${sep}assets${sep}`);
    res.writeHead(200, {
      "content-type": MIME[extname(target)] ?? "application/octet-stream",
      "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
      "access-control-allow-origin": "*",
    });
    createReadStream(target).pipe(res);
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://relay");
    const path = url.pathname;
    let m: RegExpMatchArray | null;

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET",
        "access-control-max-age": "86400",
      });
      return res.end();
    }
    if (req.method === "POST" && (m = path.match(/^\/ingest\/([^/]+)$/))) {
      if (!UUID.test(m[1]!)) throw new HttpError(404, "Не найдено");
      return ingest(req, res, m[1]!.toLowerCase());
    }
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Метод не поддерживается");

    if (path === "/health") return json(res, 200, { ok: true });
    if (path === "/api/competitions") return json(res, 200, store.list());
    if ((m = path.match(/^\/api\/competitions\/([^/]+)(\/events)?$/))) {
      const id = m[1]!.toLowerCase();
      if (!UUID.test(id)) throw new HttpError(404, "Не найдено");
      if (m[2]) return stream(req, res, id);
      const snapshot = store.get(id);
      if (!snapshot) throw new HttpError(404, "Результатов этого соревнования пока нет");
      return json(res, 200, snapshot);
    }
    if (path === "/embed.js") return serveStatic(res, config.publicDir, "embed.js");
    if (path === "/" || path === "/widget") {
      res.writeHead(302, { location: "/widget/" });
      return res.end();
    }
    if (path.startsWith("/widget/")) {
      return serveStatic(res, config.widgetDist, path.slice("/widget/".length) || "index.html", "index.html");
    }
    throw new HttpError(404, "Не найдено");
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : e instanceof SyntaxError ? 400 : 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) json(res, status, { message: status === 500 ? "Внутренняя ошибка" : (e as Error).message });
      else res.end();
    });
  });

  return {
    server,
    store,
    async close() {
      clearInterval(heartbeat);
      for (const set of viewers.values()) for (const res of set) res.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-cache",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, "Слишком большой снимок"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
