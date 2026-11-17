import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { INestApplication } from "@nestjs/common";
import type { SiteCardView } from "@ag/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, api, startApp } from "./helpers";

let app: INestApplication;
let wp: Server;
/** Карточки «сайта»: ID соревнования → карточка. */
const cards = new Map<string, Record<string, unknown>>();
const posted: Record<string, unknown>[] = [];
let password = "abcd efgh ijkl mnop qrst uvwx";

beforeAll(async () => {
  wp = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      const url = new URL(req.url!, "http://wp");
      const json = (status: number, data: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
      if (url.searchParams.get("rest_route") !== "/ag/v1/competition") return json(404, { code: "rest_no_route", message: "No route" });
      const expected = `Basic ${Buffer.from(`editor:${password.replace(/\s+/g, "")}`).toString("base64")}`;
      if (req.headers.authorization !== expected) return json(401, { code: "incorrect_password", message: "bad" });
      if (req.method === "GET") {
        const card = cards.get(url.searchParams.get("id")!);
        return card ? json(200, card) : json(404, { code: "ag_not_found", message: "нет" });
      }
      const p = JSON.parse(body) as { ids: string[]; name: string; start: string; end: string; venue: string; city: string };
      posted.push(p);
      const old = p.ids.map((id) => cards.get(id)).find(Boolean);
      const card = {
        id: 7,
        created: !old,
        title: old?.title ?? p.name,
        status: "publish",
        link: "http://wp/competitions/7/",
        edit: "http://wp/wp-admin/post.php?post=7&action=edit",
        start: p.start || old?.start || "",
        end: p.end || old?.end || p.start,
        venue: p.venue || old?.venue || "",
        city: p.city || old?.city || "",
        ids: p.ids,
        entries: false,
      };
      for (const id of p.ids) cards.set(id, card);
      json(200, card);
    });
  });
  await new Promise<void>((r) => wp.listen(0, "127.0.0.1", r));
  const port = (wp.address() as AddressInfo).port;
  ({ app } = await startApp({ wpUrl: `http://127.0.0.1:${port}/`, wpUser: "editor", wpAppPassword: password }));
});

afterAll(async () => {
  await app?.close();
  await new Promise((r) => wp.close(r));
});

describe("«Подключить к сайту»", () => {
  it("создаёт карточку турнира девочек и мальчиков, потом обновляет её", async () => {
    const admin = api(app, ADMIN_TOKEN);
    const girls = (await admin.post("/competitions", { name: "Первенство области", discipline: "WAG" }).expect(201)).body.id as string;
    const boys = (await admin.post("/competitions", { name: "Первенство области", discipline: "MAG", pairWith: girls }).expect(201)).body.id as string;
    await admin.post(`/competitions/${girls}/gymnasts/import`, { rows: [{ bib: 1, lastName: "Аксёнова", firstName: "Ася", category: "КМС" }] }).expect(201);
    await admin.post(`/competitions/${boys}/gymnasts/import`, { rows: [{ bib: 2, lastName: "Аксёнов", firstName: "Антон", category: "1 юношеский" }] }).expect(201);

    let view = (await admin.get(`/competitions/${boys}/site-card`).expect(200)).body as SiteCardView;
    expect(view).toMatchObject({ enabled: true, card: null, error: null, trial: false });

    await admin.post(`/competitions/${girls}/site-card`, { start: "2030-05-10", end: "2030-05-09", venue: "", city: "" }).expect(400);
    view = (await admin.post(`/competitions/${boys}/site-card`, { start: "2030-05-10", end: "2030-05-11", venue: "СК «Заречье»", city: "Дзержинск" }).expect(201)).body;
    expect(view.card).toMatchObject({ created: true, title: "Первенство области", start: "2030-05-10", city: "Дзержинск" });
    expect(posted.at(-1)).toMatchObject({ ids: [girls, boys], gender: "both", levels: "КМС, 1 юношеский", entryKey: "" });

    view = (await admin.get(`/competitions/${girls}/site-card`).expect(200)).body;
    expect(view.card?.venue).toBe("СК «Заречье»");
    view = (await admin.post(`/competitions/${girls}/site-card`, { start: "2030-05-12", end: "", venue: "", city: "" }).expect(201)).body;
    expect(view.card).toMatchObject({ created: false, start: "2030-05-12", venue: "СК «Заречье»" });

    const log = (await admin.get(`/competitions/${girls}/audit`).expect(200)).body as { action: string }[];
    expect(log.filter((e) => e.action === "site.card")).toHaveLength(2);
  });

  it("понятно говорит, что пароль приложения не подошёл", async () => {
    const admin = api(app, ADMIN_TOKEN);
    const id = (await admin.post("/competitions", { name: "Кубок", discipline: "WAG" }).expect(201)).body.id as string;
    const saved = password;
    password = "другой";
    try {
      const view = (await admin.get(`/competitions/${id}/site-card`).expect(200)).body as SiteCardView;
      expect(view.error).toContain("пароль приложения");
      const res = await admin.post(`/competitions/${id}/site-card`, { start: "2030-06-01", end: "", venue: "", city: "" }).expect(502);
      expect(res.body.message).toContain("WP_APP_PASSWORD");
    } finally {
      password = saved;
    }
  });
});
