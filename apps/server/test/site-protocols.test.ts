import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { INestApplication } from "@nestjs/common";
import type { RelayProtocols } from "@ag/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, api, startApp } from "./helpers";

const RELAY_TOKEN = "relay-token-0123456789";

let app: INestApplication;
let relay: Server;
let admin: ReturnType<typeof api>;
let competitionId: string;
const requests: { method: string; url: string; body: RelayProtocols | null }[] = [];

beforeAll(async () => {
  relay = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      if (req.headers.authorization !== `Bearer ${RELAY_TOKEN}`) return res.writeHead(401).end();
      // Снимки результатов тоже идут на ретранслятор: в этом тесте нужны только протоколы.
      if (!req.url!.startsWith("/protocols/")) return res.writeHead(200, { "content-type": "application/json" }).end("{}");
      const parsed = body ? (JSON.parse(body) as RelayProtocols) : null;
      requests.push({ method: req.method!, url: req.url!, body: parsed });
      const index = {
        publishedAt: "2030-01-01T00:00:00.000Z",
        files: (parsed?.files ?? []).map(({ data, ...f }) => ({ ...f, size: Buffer.from(data, "base64").length })),
      };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(req.method === "PUT" ? index : { ok: true }));
    });
  });
  await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
  ({ app } = await startApp({ relayUrl: `http://127.0.0.1:${(relay.address() as AddressInfo).port}/`, relayToken: RELAY_TOKEN }));
  admin = api(app, ADMIN_TOKEN);
  competitionId = (await admin.post("/competitions", { name: "Кубок города", discipline: "WAG" }).expect(201)).body.id;
  const rows = [
    { bib: 1, lastName: "Абрамова", firstName: "Анна", club: "Олимп", category: "КМС" },
    { bib: 2, lastName: "Белова", firstName: "Бэлла", club: "Старт", category: "1 разряд" },
  ];
  await admin.post(`/competitions/${competitionId}/gymnasts/import`, { rows }).expect(201);
});

afterAll(async () => {
  await app?.close();
  await new Promise((r) => relay.close(r));
});

const base = () => `/competitions/${competitionId}/site-protocols`;

describe("протоколы на сайте", () => {
  it("без оценок выкладывать нечего, а без секретариата нельзя", async () => {
    await api(app).post(base()).expect(401);
    expect((await admin.get(base()).expect(200)).body).toEqual({
      enabled: true,
      published: null,
      page: `http://127.0.0.1:${(relay.address() as AddressInfo).port}/widget/index.html#c=${competitionId}&view=docs`,
    });
    expect((await admin.post(base()).expect(409)).body.message).toContain("выкладывать нечего");
  });

  it("выкладывает протоколы разрядов, где есть оценки, общекомандный зачёт и Excel", async () => {
    const people = (await admin.get(`/competitions/${competitionId}/gymnasts`).expect(200)).body as { id: string; bib: number }[];
    const sv = (
      await admin
        .post(`/competitions/${competitionId}/judges`, { name: "СС", apparatus: "BB", role: "SUPERVISOR", seat: 1, enterAllMarks: true })
        .expect(201)
    ).body.token as string;
    for (const role of ["D", "E"]) {
      await admin.post(`/competitions/${competitionId}/judges`, { name: role, apparatus: "BB", role, seat: 1 }).expect(201);
    }
    const perf = (
      await api(app, sv).post(`/competitions/${competitionId}/performances`, { gymnastId: people.find((g) => g.bib === 1)!.id, apparatus: "BB" }).expect(201)
    ).body;
    await api(app, sv).post(`/performances/${perf.id}/tablet-score`, { d: 4, e: [1] }).expect(201);
    await admin.put(`/competitions/${competitionId}/club-standing`, { allAround: [], apparatus: [3, 2, 1], teams: [], best: null }).expect(200);

    const view = (await admin.post(base()).expect(201)).body;
    const sent = requests.at(-1)!;
    expect(sent.method).toBe("PUT");
    expect(sent.url).toBe(`/protocols/${competitionId}`);
    expect(sent.body!.files.map((f) => [f.file, f.title, f.group])).toEqual([
      ["all-around-1.pdf", "Многоборье", "КМС"],
      ["bb-1.pdf", "Бревно", "КМС"],
      ["clubs.pdf", "Общекомандный зачёт", ""],
      ["results.xlsx", "Все итоги в Excel", ""],
    ]);
    expect(Buffer.from(sent.body!.files[0]!.data, "base64").subarray(0, 4).toString()).toBe("%PDF");
    expect(view.published.files).toHaveLength(4);
    expect((await api(app).get(`/competitions/${competitionId}`).expect(200)).body.siteProtocols.files).toHaveLength(4);
  });

  it("снимает протоколы с сайта", async () => {
    expect((await admin.delete(base()).expect(200)).body.published).toBeNull();
    expect(requests.at(-1)).toMatchObject({ method: "DELETE", url: `/protocols/${competitionId}` });
    const log = (await admin.get(`/competitions/${competitionId}/audit?group=setup`).expect(200)).body as { text: string }[];
    expect(log.slice(0, 2).map((e) => e.text)).toEqual(["Протоколы сняты с сайта", "Протоколы выложены на сайт: файлов — 4"]);
  });
});
