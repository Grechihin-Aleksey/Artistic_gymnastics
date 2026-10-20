import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { INestApplication } from "@nestjs/common";
import type { OnlineEntriesView, OnlineEntryCall, ReceivedOnlineEntry } from "@ag/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, api, startApp } from "./helpers";

const RELAY_TOKEN = "relay-token-0123456789";

let app: INestApplication;
let offline: INestApplication;
let relay: Server;
let admin: ReturnType<typeof api>;
let competitionId: string;
/** Что зал опубликовал на «сайте» и что «клубы» туда прислали. */
const published: { key: string; call: OnlineEntryCall; decisions?: Record<string, { status: string; note: string | null }> }[] = [];
const submitted: ReceivedOnlineEntry[] = [];
let down = false;

beforeAll(async () => {
  relay = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      if (down || req.headers.authorization !== `Bearer ${RELAY_TOKEN}`) return res.writeHead(down ? 503 : 401).end();
      if (req.method === "PUT") published.push(JSON.parse(body) as (typeof published)[number]);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(req.method === "GET" ? { entries: submitted } : { ok: true }));
    });
  });
  await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
  const port = (relay.address() as AddressInfo).port;
  ({ app } = await startApp({ relayUrl: `http://127.0.0.1:${port}/site/`, relayToken: RELAY_TOKEN }));
  admin = api(app, ADMIN_TOKEN);
  competitionId = (await admin.post("/competitions", { name: "Кубок города", discipline: "WAG" }).expect(201)).body.id;
  await admin
    .post(`/competitions/${competitionId}/gymnasts/import`, { rows: [{ bib: 7, lastName: "Абрамова", firstName: "Анна", category: "КМС" }] })
    .expect(201);
});

afterAll(async () => {
  await app?.close();
  await offline?.close();
  await new Promise((r) => relay.close(r));
});

const base = () => `/competitions/${competitionId}/online-entries`;
let received = Date.parse("2030-04-01T10:00:00Z");
const entry = (club: string, rows: ReceivedOnlineEntry["rows"]): ReceivedOnlineEntry => ({
  id: randomUUID(),
  receivedAt: new Date((received += 60_000)).toISOString(),
  club,
  city: "Тверь",
  contact: "Иванова И. И., +7 900 000-00-00",
  rows,
});

describe("онлайн-заявки клубов", () => {
  it("открывает приём на сайте и даёт ссылку с секретным ключом", async () => {
    await api(app).get(base()).expect(401);
    expect((await admin.get(base()).expect(200)).body).toMatchObject({ enabled: true, open: false, link: null, entries: [] });
    await admin.post(`${base()}/sync`).expect(409);

    const deadline = "2030-05-01T18:00:00.000Z";
    const view = (await admin.put(`${base()}/settings`, { open: true, deadline }).expect(200)).body as OnlineEntriesView;
    expect(view).toMatchObject({ open: true, deadline });
    const { key, call } = published.at(-1)!;
    expect(call).toEqual({ name: "Кубок города", discipline: "WAG", open: true, deadline, categories: ["КМС"] });
    expect(view.link).toBe(`http://127.0.0.1:${(relay.address() as AddressInfo).port}/site/entry/index.html#c=${competitionId}&k=${key}`);
    // Ключ ссылки не уходит в открытые данные соревнования.
    expect(JSON.stringify((await api(app).get(`/competitions/${competitionId}`).expect(200)).body)).not.toContain(key);

    // При повторном открытии ключ тот же: разосланная ссылка продолжает работать.
    await admin.put(`${base()}/settings`, { open: false }).expect(200);
    expect(published.at(-1)).toMatchObject({ key, call: { open: false, deadline: null } });
  });

  it("забирает заявки, принимает их в список с номерами и отклоняет", async () => {
    const olimp = entry("Олимп", [
      { lastName: "Белова", firstName: "Бэлла", category: "КМС", birthDate: "2012", coach: "Петрова Н. Н." },
      { lastName: "Волкова", firstName: "Вера", category: "1 разряд", team: "Олимп-1" },
    ]);
    const start = entry("Старт", [{ lastName: "Глебова", firstName: "Галя" }]);
    submitted.push(olimp, start);
    let view = (await admin.post(`${base()}/sync`).expect(201)).body as OnlineEntriesView;
    expect(view.entries.map((e) => [e.club, e.status])).toEqual([["Олимп", "NEW"], ["Старт", "NEW"]]);
    expect(view.syncedAt).not.toBeNull();
    // Повторная синхронизация не дублирует.
    expect(((await admin.post(`${base()}/sync`).expect(201)).body as OnlineEntriesView).entries).toHaveLength(2);

    view = (await admin.post(`${base()}/${olimp.id}/accept`).expect(201)).body;
    expect(view.entries[0]).toMatchObject({ status: "ACCEPTED" });
    await admin.post(`${base()}/${olimp.id}/accept`).expect(409);
    const people = (await admin.get(`/competitions/${competitionId}/gymnasts`).expect(200)).body as {
      bib: number;
      lastName: string;
      club: string | null;
      city: string | null;
      coach: string | null;
      birthDate: string | null;
    }[];
    expect(people.map((g) => [g.bib, g.lastName, g.club, g.city])).toEqual([
      [7, "Абрамова", null, null],
      [8, "Белова", "Олимп", "Тверь"],
      [9, "Волкова", "Олимп", "Тверь"],
    ]);
    expect(people[1]).toMatchObject({ coach: "Петрова Н. Н.", birthDate: "2012" });

    view = (await admin.post(`${base()}/${start.id}/reject`, { note: "Нет медицинского допуска" }).expect(201)).body;
    expect(view.entries[1]).toMatchObject({ status: "REJECTED", note: "Нет медицинского допуска" });
    await admin.post(`${base()}/${randomUUID()}/reject`, {}).expect(404);
    // Решения сразу уходят на сайт: клуб видит статус своей заявки.
    expect(published.at(-1)!.decisions).toEqual({
      [olimp.id]: expect.objectContaining({ status: "ACCEPTED", note: null }),
      [start.id]: expect.objectContaining({ status: "REJECTED", note: "Нет медицинского допуска" }),
    });

    const log = (await admin.get(`/competitions/${competitionId}/audit?group=roster`).expect(200)).body as { text: string }[];
    expect(log.slice(0, 2).map((e) => e.text)).toEqual([
      "Отклонена онлайн-заявка клуба «Старт»: Нет медицинского допуска",
      "Принята онлайн-заявка клуба «Олимп»: 2 чел. добавлено в список",
    ]);
  });

  it("говорит, если сайта нет или он не отвечает", async () => {
    down = true;
    expect((await admin.post(`${base()}/sync`).expect(502)).body.message).toBe("Сайт соревнований ответил ошибкой 503");
    down = false;
    ({ app: offline } = await startApp());
    const local = api(offline, ADMIN_TOKEN);
    const id = (await local.post("/competitions", { name: "Без сайта", discipline: "MAG" }).expect(201)).body.id;
    expect((await local.get(`/competitions/${id}/online-entries`).expect(200)).body.enabled).toBe(false);
    expect((await local.put(`/competitions/${id}/online-entries/settings`, { open: true }).expect(409)).body.message).toContain("RELAY_URL");
  });
});
