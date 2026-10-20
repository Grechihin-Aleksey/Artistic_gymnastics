import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BoardSnapshot, PerformanceView, RelayIngest } from "@ag/shared";
import { createRelay, type Relay } from "../src/server.js";

const TOKEN = "relay-token-0123456789";
const ID = "0b9b6a52-6c1e-4f0e-9a4f-2f1d3c4b5a69";

function snapshot(name: string, generatedAt: string): BoardSnapshot {
  return {
    competition: { id: ID, name, discipline: "WAG" },
    live: [],
    categories: [{ id: null, name: "", allAround: [], teams: [], apparatus: {} }],
    generatedAt,
  };
}

let relay: Relay;
let base: string;
let dataDir: string;

async function start() {
  relay = await createRelay({ port: 0, token: TOKEN, dataDir, publicDir: join(import.meta.dirname, "..", "public") });
  await new Promise<void>((resolve) => relay.server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(relay.server.address() as AddressInfo).port}`;
}

const ingest = (body: RelayIngest, token = TOKEN, id = ID) =>
  fetch(`${base}/ingest/${id}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

/** Читает поток событий, пока не наберёт n событий. */
async function readEvents(response: Response, n: number) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const events: { event: string; data: unknown }[] = [];
  while (events.length < n) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = text.indexOf("\n\n")) >= 0) {
      const frame = text.slice(0, end);
      text = text.slice(end + 2);
      const event = /^event: (.*)$/m.exec(frame)?.[1];
      const data = /^data: (.*)$/m.exec(frame)?.[1];
      if (event && data) events.push({ event, data: JSON.parse(data) });
    }
  }
  await reader.cancel();
  return events;
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "relay-"));
  await start();
});

afterEach(async () => {
  await relay.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("ретранслятор", () => {
  it("принимает снимки только с верным токеном", async () => {
    expect((await ingest({ snapshot: snapshot("A", "2026-01-01T10:00:00Z"), approved: [] }, "wrong-token")).status).toBe(401);
    expect((await fetch(`${base}/api/competitions/${ID}`)).status).toBe(404);
    const other = "1b9b6a52-6c1e-4f0e-9a4f-2f1d3c4b5a69";
    expect((await ingest({ snapshot: snapshot("A", "2026-01-01T10:00:00Z"), approved: [] }, TOKEN, other)).status).toBe(400);
  });

  it("раздаёт последний снимок и список соревнований", async () => {
    expect((await ingest({ snapshot: snapshot("Кубок", "2026-01-01T10:00:00Z"), approved: [] })).status).toBe(200);
    const got = (await (await fetch(`${base}/api/competitions/${ID}`)).json()) as BoardSnapshot;
    expect(got.competition.name).toBe("Кубок");
    const list = (await (await fetch(`${base}/api/competitions`)).json()) as { id: string; name: string }[];
    expect(list).toMatchObject([{ id: ID, name: "Кубок" }]);
  });

  it("не затирает свежий снимок запоздавшим", async () => {
    await ingest({ snapshot: snapshot("новый", "2026-01-01T10:05:00Z"), approved: [] });
    const late = await ingest({ snapshot: snapshot("старый", "2026-01-01T10:00:00Z"), approved: [] });
    expect(await late.json()).toMatchObject({ stale: true });
    const got = (await (await fetch(`${base}/api/competitions/${ID}`)).json()) as BoardSnapshot;
    expect(got.competition.name).toBe("новый");
  });

  it("шлёт зрителям снимок при подключении, затем обновления и утверждённые оценки", async () => {
    await ingest({ snapshot: snapshot("v1", "2026-01-01T10:00:00Z"), approved: [] });
    const stream = await fetch(`${base}/api/competitions/${ID}/events`);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const reading = readEvents(stream, 3);
    // Даём потоку зарегистрироваться до отправки нового снимка.
    await new Promise((r) => setTimeout(r, 50));
    const approved: PerformanceView = {
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
    await ingest({ snapshot: snapshot("v2", "2026-01-01T10:01:00Z"), approved: [approved] });
    const events = await reading;
    expect(events.map((e) => e.event)).toEqual(["snapshot", "snapshot", "approved"]);
    expect((events[1]!.data as BoardSnapshot).competition.name).toBe("v2");
    expect(events[2]!.data).toMatchObject({ id: "p1", score: { total: 13 } });
  });

  it("после перезапуска отдаёт сохранённые результаты", async () => {
    await ingest({ snapshot: snapshot("сохранён", "2026-01-01T10:00:00Z"), approved: [] });
    await relay.close();
    await start();
    const got = (await (await fetch(`${base}/api/competitions/${ID}`)).json()) as BoardSnapshot;
    expect(got.competition.name).toBe("сохранён");
  });

  it("отдаёт скрипт встраивания и не выпускает за пределы папок", async () => {
    const embed = await fetch(`${base}/embed.js`);
    expect(embed.status).toBe(200);
    expect(await embed.text()).toContain("data-ag-results");
    expect((await fetch(`${base}/widget/..%2f..%2fpackage.json`)).status).toBe(404);
  });

  it("принимает онлайн-заявки клубов по ссылке с ключом и отдаёт их залу", async () => {
    const KEY = "entry-key-0123456789abcdef";
    const call = { name: "Кубок города", discipline: "WAG", open: true, deadline: null, categories: ["КМС", "1 разряд"] };
    const publish = (body: unknown, token = TOKEN) =>
      fetch(`${base}/entries/${ID}`, {
        method: "PUT",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
    const club = (body: unknown, key = KEY) =>
      fetch(`${base}/api/entries/${ID}?k=${key}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const entry = { club: "Олимп", contact: "Иванова И. И., +7 900 000-00-00", rows: [{ lastName: "Абрамова", firstName: "Анна", category: "КМС" }] };

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
    const sent = await club(entry);
    expect(sent.status).toBe(201);
    const { id } = (await sent.json()) as { id: string };

    // Клуб видит статус по номеру; решение приходит из зала.
    const status = async () => (await (await fetch(`${base}/api/entries/${ID}/${id}?k=${KEY}`)).json()) as { status: string; note: string | null };
    expect(await status()).toMatchObject({ id, club: "Олимп", count: 1, status: "NEW", note: null });
    expect((await fetch(`${base}/api/entries/${ID}/${id}?k=wrong-key-0123456789abc`)).status).toBe(404);
    expect((await fetch(`${base}/api/entries/${ID}/0b9b6a52-0000-4f0e-9a4f-2f1d3c4b5a69?k=${KEY}`)).status).toBe(404);
    await publish({ key: KEY, call, decisions: { [id]: { status: "REJECTED", note: "Нет допуска", decidedAt: "2030-01-01T00:00:00Z" } } });
    expect(await status()).toMatchObject({ status: "REJECTED", note: "Нет допуска" });
    // Публикация без решений их не стирает.
    await publish({ key: KEY, call });
    expect((await status()).status).toBe("REJECTED");

    const hall = (token = TOKEN) => fetch(`${base}/entries/${ID}`, { headers: { authorization: `Bearer ${token}` } });
    expect((await hall("wrong-token")).status).toBe(401);
    expect(await (await hall()).json()).toEqual({ entries: [expect.objectContaining({ ...entry, id })] });

    // После перезапуска заявки на месте, а закрытый приём новых не берёт.
    await relay.close();
    await start();
    expect((await publish({ key: KEY, call: { ...call, open: false } })).status).toBe(200);
    expect(((await (await hall()).json()) as { entries: unknown[] }).entries).toHaveLength(1);
    expect((await club(entry)).status).toBe(409);
    expect((await publish({ key: KEY, call: { ...call, deadline: "2020-01-01T00:00:00Z" } })).status).toBe(200);
    expect((await club(entry)).status).toBe(409);
    expect((await fetch(`${base}/entry/`)).status).toBe(200);
    expect((await fetch(`${base}/entry/index.html`)).status).toBe(200);
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

    // Новая публикация заменяет прежнюю целиком и переживает перезапуск.
    await put({ files: [files[1]] });
    await relay.close();
    await start();
    expect(((await (await fetch(`${base}/api/competitions/${ID}/protocols`)).json()) as { files: unknown[] }).files).toHaveLength(1);
    expect((await fetch(`${base}/api/competitions/${ID}/protocols/all-around-1.pdf`)).status).toBe(404);
    expect((await put(null, TOKEN, "DELETE")).status).toBe(200);
    expect((await fetch(`${base}/api/competitions/${ID}/protocols/results.xlsx`)).status).toBe(404);
  });
});
