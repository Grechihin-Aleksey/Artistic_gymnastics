import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { INestApplication } from "@nestjs/common";
import type { BoardSnapshot, RelayIngest } from "@ag/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, api, startApp } from "./helpers";

const RELAY_TOKEN = "relay-token-0123456789";

let app: INestApplication;
let relay: Server;
const received: { path: string; auth: string | undefined; body: RelayIngest }[] = [];
/** Сколько первых запросов ретранслятор «не принимает», как при обрыве связи. */
let failFirst = 0;

beforeAll(async () => {
  relay = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      if (failFirst > 0) {
        failFirst--;
        res.writeHead(503).end();
        return;
      }
      received.push({ path: req.url!, auth: req.headers.authorization, body: JSON.parse(body) as RelayIngest });
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
  const port = (relay.address() as AddressInfo).port;
  ({ app } = await startApp({ relayUrl: `http://127.0.0.1:${port}/`, relayToken: RELAY_TOKEN }));
});

afterAll(async () => {
  await app?.close();
  await new Promise((r) => relay.close(r));
});

async function waitFor<T>(check: () => T | undefined, timeout = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() - start > timeout) throw new Error("не дождались");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("отправка на сайт", () => {
  it("после утверждения оценки отправляет снимок и саму оценку, повторяя при обрыве связи", async () => {
    const admin = api(app, ADMIN_TOKEN);
    const competition = (await admin.post("/competitions", { name: "Кубок", discipline: "WAG" }).expect(201)).body;
    const gymnast = (
      await admin
        .post(`/competitions/${competition.id}/gymnasts`, { bib: 3, firstName: "Ольга", lastName: "Орлова" })
        .expect(201)
    ).body;
    const judge = async (role: string) =>
      (await admin.post(`/competitions/${competition.id}/judges`, { name: role, apparatus: "BB", role, seat: 1 }).expect(201))
        .body.token as string;
    const [d, e, sv] = [await judge("D"), await judge("E"), await judge("SUPERVISOR")];

    failFirst = 1;
    const perf = (await admin.post(`/competitions/${competition.id}/performances`, { gymnastId: gymnast.id, apparatus: "BB" }).expect(201)).body;
    await api(app, d).post("/marks", { id: randomUUID(), performanceId: perf.id, kind: "D", value: 5.2 }).expect(201);
    await api(app, e).post("/marks", { id: randomUUID(), performanceId: perf.id, kind: "E", value: 1.4 }).expect(201);
    await api(app, sv).post(`/performances/${perf.id}/approve`).expect(201);

    const sent = await waitFor(() =>
      received.find((r) => r.body.snapshot.live.find((a) => a.apparatus === "BB")?.last?.performanceId === perf.id),
    );
    expect(failFirst).toBe(0);
    expect(sent.path).toBe(`/ingest/${competition.id}`);
    expect(sent.auth).toBe(`Bearer ${RELAY_TOKEN}`);
    expect(sent.body.snapshot.competition).toEqual({ id: competition.id, name: "Кубок", discipline: "WAG", rules: "FIG" });
    expect(sent.body.snapshot.categories[0]!.apparatus.BB?.[0]?.score.total).toBe(13.8);
    expect(sent.body.approved.map((p) => p.id)).toContain(perf.id);
    // Сбавки отдельных судей на сайт не уходят, пока соревнование их не публикует.
    expect(sent.body.approved[0]!.marks).toEqual([]);
  });

  it("снимок для табло отдаётся одним запросом", async () => {
    const admin = api(app, ADMIN_TOKEN);
    const competition = (await admin.post("/competitions", { name: "Пустое", discipline: "MAG" }).expect(201)).body;
    const snapshot = (await api(app).get(`/competitions/${competition.id}/results/snapshot`).expect(200)).body as BoardSnapshot;
    expect(snapshot.live.map((a) => a.apparatus)).toEqual(["FX", "PH", "SR", "VT", "PB", "HB"]);
    expect(snapshot.categories).toHaveLength(1);
    expect(snapshot.categories[0]!.id).toBeNull();
    expect(Object.keys(snapshot.categories[0]!.apparatus)).toHaveLength(6);
    expect(snapshot.categories[0]!.teams).toEqual([]);
  });
});
