import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BoardSnapshot, PerformanceView, RelayIngest } from "@ag/shared";

const TOKEN = "relay-token-0123456789";
const ID = "0b9b6a52-6c1e-4f0e-9a4f-2f1d3c4b5a69";
const hasPhp = spawnSync("php", ["-v"]).status === 0;

function snapshot(name: string, generatedAt: string): BoardSnapshot {
  return {
    competition: { id: ID, name, discipline: "WAG" },
    live: [],
    categories: [{ id: null, name: "", allAround: [], teams: [], apparatus: {} }],
    generatedAt,
  };
}

const view: PerformanceView = {
  id: "p1",
  competitionId: ID,
  gymnastId: "g1",
  apparatus: "BB",
  attempt: 1,
  stage: "QUAL",
  status: "APPROVED",
  score: { d: 5, e: 8, neutral: 0, total: 13 },
  marks: [],
};

let php: ChildProcess;
let base: string;
let dataDir: string;

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

const ingest = (body: RelayIngest, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }, id = ID) =>
  fetch(`${base}/ingest/${id}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

/** PHP отдаёт изменения и закрывает ответ: разбираем его целиком. */
async function poll(lastEventId?: string) {
  const response = await fetch(`${base}/api/competitions/${ID}/events`, { headers: lastEventId ? { "last-event-id": lastEventId } : {} });
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const frames = (await response.text()).split("\n\n").filter(Boolean);
  return frames.flatMap((frame) => {
    const event = /^event: (.*)$/m.exec(frame)?.[1];
    const data = /^data: (.*)$/m.exec(frame)?.[1];
    return event && data ? [{ event, id: /^id: (.*)$/m.exec(frame)?.[1], data: JSON.parse(data) as unknown }] : [];
  });
}

describe.skipIf(!hasPhp)("PHP-ретранслятор", () => {
  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "relay-php-"));
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    php = spawn("php", ["-S", `127.0.0.1:${port}`, "dev-router.php"], {
      cwd: join(import.meta.dirname, "..", "php"),
      env: { ...process.env, RELAY_TOKEN: TOKEN, RELAY_DATA_DIR: dataDir, RELAY_POLL_MS: "1000" },
      stdio: "ignore",
    });
    for (let i = 0; i < 100; i++) {
      if (await fetch(`${base}/health`).then((r) => r.ok, () => false)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  afterAll(async () => {
    php?.kill();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("принимает снимки только с верным токеном, в том числе из X-Relay-Token", async () => {
    expect((await ingest({ snapshot: snapshot("A", "2026-01-01T09:00:00Z"), approved: [] }, { authorization: "Bearer wrong-token" })).status).toBe(401);
    expect((await fetch(`${base}/api/competitions/${ID}`)).status).toBe(404);
    const other = "1b9b6a52-6c1e-4f0e-9a4f-2f1d3c4b5a69";
    expect((await ingest({ snapshot: snapshot("A", "2026-01-01T09:00:00Z"), approved: [] }, undefined, other)).status).toBe(400);
    expect((await ingest({ snapshot: snapshot("A", "2026-01-01T09:00:00Z"), approved: [] }, { "x-relay-token": TOKEN })).status).toBe(200);
  });

  it("раздаёт последний снимок как есть и не затирает его запоздавшим", async () => {
    await ingest({ snapshot: snapshot("Кубок", "2026-01-01T10:05:00Z"), approved: [] });
    const late = await ingest({ snapshot: snapshot("старый", "2026-01-01T10:00:00Z"), approved: [] });
    expect(await late.json()).toMatchObject({ stale: true });
    const got = await (await fetch(`${base}/api/competitions/${ID}`)).json();
    expect(got).toEqual(snapshot("Кубок", "2026-01-01T10:05:00Z"));
    const list = (await (await fetch(`${base}/api/competitions`)).json()) as { id: string; name: string }[];
    expect(list).toMatchObject([{ id: ID, name: "Кубок", discipline: "WAG" }]);
  });

  it("при опросе отдаёт только то, что изменилось с прошлого раза", async () => {
    const first = await poll();
    expect(first.map((e) => e.event)).toEqual(["snapshot"]);
    const seen = first[0]!.id!;
    expect(await poll(seen)).toEqual([]);

    await ingest({ snapshot: snapshot("v2", "2026-01-01T10:06:00Z"), approved: [view] });
    const next = await poll(seen);
    expect(next.map((e) => e.event)).toEqual(["snapshot", "approved"]);
    expect((next[0]!.data as BoardSnapshot).competition.name).toBe("v2");
    expect(next[1]!.data).toMatchObject({ id: "p1", score: { total: 13 } });
    // Новый зритель видит снимок, но не всплывающие старые оценки.
    expect((await poll()).map((e) => e.event)).toEqual(["snapshot"]);
    expect(await poll(next[0]!.id)).toEqual([]);
  });

  it("принимает онлайн-заявки клубов по ссылке с ключом и отдаёт их залу", async () => {
    const KEY = "entry-key-0123456789abcdef";
    const call = { name: "Кубок города", discipline: "WAG", open: true, deadline: null, categories: ["КМС", "1 разряд"] };
    const publish = (body: unknown, token = TOKEN) =>
      fetch(`${base}/entries/${ID}`, { method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    const club = (body: unknown, key = KEY) =>
      fetch(`${base}/api/entries/${ID}?k=${key}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const entry = { club: " Олимп ", contact: "Иванова И. И., +7 900 000-00-00", rows: [{ lastName: "Абрамова", firstName: "Анна", category: "КМС", extra: 1 }] };

    expect((await publish({ key: KEY, call }, "wrong-token")).status).toBe(401);
    expect((await fetch(`${base}/api/entries/${ID}?k=${KEY}`)).status).toBe(404);
    expect((await publish({ key: KEY, call })).status).toBe(200);
    expect(await (await fetch(`${base}/api/entries/${ID}?k=${KEY}`)).json()).toEqual(call);
    expect((await fetch(`${base}/api/entries/${ID}?k=wrong-key-0123456789abc`)).status).toBe(404);

    const bad = await club({ ...entry, rows: [{ lastName: "Белова", firstName: "" }] });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { message: string }).message).toBe("Участник 1: Укажите имя");
    const unknown = await club({ ...entry, rows: [{ lastName: "Белова", firstName: "Бэлла", category: "МС" }] });
    expect(((await unknown.json()) as { message: string }).message).toBe("Разряда «МС» нет в соревновании");
    const date = await club({ ...entry, rows: [{ lastName: "Белова", firstName: "Бэлла", birthDate: "весной" }] });
    expect(((await date.json()) as { message: string }).message).toBe("Участник 1: Дата рождения: год (2012) или дата (15.03.2012)");
    const sent = await club(entry);
    expect(sent.status).toBe(201);
    const { id } = (await sent.json()) as { id: string };
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    const status = async () => (await (await fetch(`${base}/api/entries/${ID}/${id}?k=${KEY}`)).json()) as { status: string; note: string | null };
    expect(await status()).toMatchObject({ id, club: "Олимп", count: 1, status: "NEW", note: null });
    expect((await fetch(`${base}/api/entries/${ID}/${id}?k=wrong-key-0123456789abc`)).status).toBe(404);
    await publish({ key: KEY, call, decisions: { [id]: { status: "REJECTED", note: "Нет допуска", decidedAt: "2030-01-01T00:00:00Z" } } });
    expect(await status()).toMatchObject({ status: "REJECTED", note: "Нет допуска" });
    await publish({ key: KEY, call });
    expect((await status()).status).toBe("REJECTED");

    const hall = (token = TOKEN) => fetch(`${base}/entries/${ID}`, { headers: { authorization: `Bearer ${token}` } });
    expect((await hall("wrong-token")).status).toBe(401);
    const { entries } = (await (await hall()).json()) as { entries: Record<string, unknown>[] };
    // Пробелы обрезаны, лишние поля отброшены — как у Node-версии.
    expect(entries).toEqual([
      { club: "Олимп", contact: entry.contact, rows: [{ lastName: "Абрамова", firstName: "Анна", category: "КМС" }], id, receivedAt: expect.any(String) },
    ]);

    expect((await publish({ key: KEY, call: { ...call, open: false } })).status).toBe(200);
    expect((await club(entry)).status).toBe(409);
    expect((await publish({ key: KEY, call: { ...call, deadline: "2020-01-01T00:00:00Z" } })).status).toBe(200);
    expect((await club(entry)).status).toBe(409);
  });

  it("хранит выложенные протоколы, отдаёт их сайту и снимает по запросу зала", async () => {
    const put = (body: unknown, token = TOKEN, method = "PUT") =>
      fetch(`${base}/protocols/${ID}`, {
        method,
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: method === "PUT" ? JSON.stringify(body) : null,
      });
    const pdf = Buffer.from("%PDF-1.4 протокол").toString("base64");
    const files = [
      { file: "all-around-1.pdf", title: "Многоборье", group: "КМС", data: pdf },
      { file: "results.xlsx", title: "Все итоги в Excel", group: "", data: Buffer.from("xlsx").toString("base64") },
    ];
    expect((await put({ files }, "wrong-token")).status).toBe(401);
    expect((await put({ files: [{ ...files[0], file: "../x.pdf" }] })).status).toBe(400);
    expect(await (await fetch(`${base}/api/competitions/${ID}/protocols`)).json()).toEqual({ publishedAt: null, files: [] });
    expect((await put({ files })).status).toBe(200);

    const index = (await (await fetch(`${base}/api/competitions/${ID}/protocols`)).json()) as { files: unknown[] };
    expect(index.files).toEqual([
      { file: "all-around-1.pdf", title: "Многоборье", group: "КМС", size: Buffer.from(pdf, "base64").length },
      { file: "results.xlsx", title: "Все итоги в Excel", group: "", size: 4 },
    ]);
    const got = await fetch(`${base}/api/competitions/${ID}/protocols/all-around-1.pdf`);
    expect(got.headers.get("content-type")).toBe("application/pdf");
    expect(await got.text()).toBe("%PDF-1.4 протокол");
    expect((await fetch(`${base}/api/competitions/${ID}/protocols/other.pdf`)).status).toBe(404);

    await put({ files: [files[1]] });
    expect(((await (await fetch(`${base}/api/competitions/${ID}/protocols`)).json()) as { files: unknown[] }).files).toHaveLength(1);
    expect((await fetch(`${base}/api/competitions/${ID}/protocols/all-around-1.pdf`)).status).toBe(404);
    expect((await put(null, TOKEN, "DELETE")).status).toBe(200);
    expect((await fetch(`${base}/api/competitions/${ID}/protocols/results.xlsx`)).status).toBe(404);
  });

  it("не отдаёт файлы данных по прямому адресу", async () => {
    expect((await fetch(`${base}/data/results-${ID}.php`)).status).toBe(403);
    expect((await fetch(`${base}/config.php`)).status).toBe(403);
    expect((await fetch(`${base}/`, { redirect: "manual" })).headers.get("location")).toBe("/widget/index.html");
  });
});
