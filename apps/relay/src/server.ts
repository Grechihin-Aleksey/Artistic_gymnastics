import { timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { DISCIPLINES, onlineEntrySchema, RELAY_EVENTS, type BoardSnapshot, type PerformanceView } from "@ag/shared";
import { z } from "zod";
import type { RelayConfig } from "./config.js";
import { EntryStore, MAX_ENTRIES } from "./entries.js";
import { PROTOCOL_FILE, ProtocolStore } from "./protocols.js";
import { SnapshotStore } from "./store.js";

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const HEARTBEAT_MS = 25_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Проверяем только то, на что опирается сам ретранслятор; таблицы он передаёт как есть.
const ingestSchema = z.object({
  snapshot: z.looseObject({
    competition: z.looseObject({ id: z.string(), name: z.string(), discipline: z.string() }),
    live: z.array(z.unknown()),
    categories: z.array(z.unknown()),
    generatedAt: z.string(),
  }),
  approved: z.array(z.looseObject({ id: z.string() })).default([]),
});

const publishEntriesSchema = z.object({
  key: z.string().min(16).max(200),
  call: z.object({
    name: z.string().min(1).max(300),
    discipline: z.enum(DISCIPLINES),
    open: z.boolean(),
    deadline: z.string().nullable(),
    categories: z.array(z.string().max(100)).max(100),
  }),
});

/** Протоколы соревнования одной отправкой: PDF в base64. */
const MAX_PROTOCOLS_BYTES = 40 * 1024 * 1024;
const protocolsSchema = z.object({
  files: z
    .array(
      z.object({
        file: z.string().regex(PROTOCOL_FILE),
        title: z.string().min(1).max(300),
        group: z.string().max(100),
        data: z.string().regex(/^[A-Za-z0-9+/]*=*$/),
      }),
    )
    .max(300)
    .refine((files) => new Set(files.map((f) => f.file)).size === files.length, "Имена файлов повторяются"),
});

/** Заявка клуба невелика: 100 участников укладываются с запасом. */
const MAX_ENTRY_BYTES = 200 * 1024;

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
  entries: EntryStore;
  protocols: ProtocolStore;
  close(): Promise<void>;
}

/**
 * Облачный ретранслятор: принимает снимки результатов от сервера в зале
 * и раздаёт их сайту. Зрители никогда не обращаются к залу напрямую.
 */
export async function createRelay(config: RelayConfig): Promise<Relay> {
  const store = new SnapshotStore(config.dataDir);
  await store.load();
  const entries = new EntryStore(config.dataDir);
  await entries.load();
  const protocols = new ProtocolStore(config.dataDir);
  await protocols.load();
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

  /** Зал публикует приём заявок (PUT) и забирает присланные (GET). */
  async function hallEntries(req: IncomingMessage, res: ServerResponse, id: string) {
    if (!authorized(req)) throw new HttpError(401, "Неверный токен");
    if (req.method === "GET") return json(res, 200, { entries: entries.entries(id) });
    const parsed = publishEntriesSchema.safeParse(JSON.parse(await readBody(req)));
    if (!parsed.success) throw new HttpError(400, "Неверный формат приёма заявок");
    await entries.publish(id, parsed.data.call, parsed.data.key);
    json(res, 200, { ok: true });
  }

  /** Зал выкладывает протоколы (PUT, заменяя прежние) или снимает их (DELETE). */
  async function hallProtocols(req: IncomingMessage, res: ServerResponse, id: string) {
    if (!authorized(req)) throw new HttpError(401, "Неверный токен");
    if (req.method === "DELETE") {
      await protocols.remove(id);
      return json(res, 200, { ok: true });
    }
    const parsed = protocolsSchema.safeParse(JSON.parse(await readBody(req, MAX_PROTOCOLS_BYTES)));
    if (!parsed.success) throw new HttpError(400, "Неверный формат протоколов");
    json(res, 200, await protocols.publish(id, parsed.data));
  }

  /** Клуб открывает ссылку (GET) и отправляет заявку (POST). */
  async function clubEntry(req: IncomingMessage, res: ServerResponse, id: string, key: string) {
    const call = entries.call(id, key);
    if (!call) throw new HttpError(404, "Ссылка на заявку недействительна: уточните её у организаторов");
    if (req.method !== "POST") return json(res, 200, call);
    if (!call.open || (call.deadline && Date.parse(call.deadline) < Date.now())) {
      throw new HttpError(409, "Приём заявок закрыт");
    }
    if (entries.entries(id).length >= MAX_ENTRIES) throw new HttpError(409, "Заявок слишком много: свяжитесь с организаторами");
    const parsed = onlineEntrySchema.safeParse(JSON.parse(await readBody(req, MAX_ENTRY_BYTES)));
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      const row = issue.path[0] === "rows" && typeof issue.path[1] === "number" ? `Участник ${issue.path[1] + 1}: ` : "";
      throw new HttpError(400, `${row}${issue.message}`);
    }
    const unknown = parsed.data.rows.find((r) => r.category && call.categories.length > 0 && !call.categories.includes(r.category));
    if (unknown) throw new HttpError(400, `Разряда «${unknown.category}» нет в соревновании`);
    const received = await entries.add(id, parsed.data);
    json(res, 201, { id: received.id, receivedAt: received.receivedAt });
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
    if ((m = path.match(/^\/entries\/([^/]+)$/)) && (req.method === "GET" || req.method === "PUT")) {
      if (!UUID.test(m[1]!)) throw new HttpError(404, "Не найдено");
      return hallEntries(req, res, m[1]!.toLowerCase());
    }
    if ((m = path.match(/^\/protocols\/([^/]+)$/)) && (req.method === "PUT" || req.method === "DELETE")) {
      if (!UUID.test(m[1]!)) throw new HttpError(404, "Не найдено");
      return hallProtocols(req, res, m[1]!.toLowerCase());
    }
    if ((m = path.match(/^\/api\/entries\/([^/]+)$/)) && (req.method === "GET" || req.method === "POST")) {
      if (!UUID.test(m[1]!)) throw new HttpError(404, "Не найдено");
      return clubEntry(req, res, m[1]!.toLowerCase(), url.searchParams.get("k") ?? "");
    }
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Метод не поддерживается");

    if (path === "/health") return json(res, 200, { ok: true });
    if (path === "/api/competitions") return json(res, 200, store.list());
    if ((m = path.match(/^\/api\/competitions\/([^/]+)\/protocols(?:\/([^/]+))?$/))) {
      const id = m[1]!.toLowerCase();
      if (!UUID.test(id)) throw new HttpError(404, "Не найдено");
      if (!m[2]) return json(res, 200, protocols.index(id) ?? { publishedAt: null, files: [] });
      const file = decodeURIComponent(m[2]);
      const data = PROTOCOL_FILE.test(file) ? await protocols.read(id, file) : undefined;
      if (!data) throw new HttpError(404, "Протокол не найден");
      const pdf = file.endsWith(".pdf");
      res.writeHead(200, {
        "content-type": pdf ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `${pdf ? "inline" : "attachment"}; filename="${file}"`,
        "content-length": data.length,
        "cache-control": "no-cache",
        "access-control-allow-origin": "*",
      });
      return res.end(req.method === "HEAD" ? undefined : data);
    }
    if ((m = path.match(/^\/api\/competitions\/([^/]+)(\/events)?$/))) {
      const id = m[1]!.toLowerCase();
      if (!UUID.test(id)) throw new HttpError(404, "Не найдено");
      if (m[2]) return stream(req, res, id);
      const snapshot = store.get(id);
      if (!snapshot) throw new HttpError(404, "Результатов этого соревнования пока нет");
      return json(res, 200, snapshot);
    }
    if (path === "/embed.js") return serveStatic(res, config.publicDir, "embed.js");
    if (path === "/entry" || path === "/entry/") return serveStatic(res, config.publicDir, "entry.html");
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
    entries,
    protocols,
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

function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, "Слишком большой запрос"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
