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
    allAround: [],
    teams: [],
    apparatus: {},
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
});
