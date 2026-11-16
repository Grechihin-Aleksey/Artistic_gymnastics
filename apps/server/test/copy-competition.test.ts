import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, api, startApp } from "./helpers";

let app: INestApplication;
let admin: ReturnType<typeof api>;

beforeAll(async () => {
  ({ app } = await startApp());
  admin = api(app, ADMIN_TOKEN);
});

afterAll(async () => {
  await app?.close();
});

describe("новый турнир по образцу прошлого", () => {
  it("переносит правила, разряды, коллегию и судей с новыми кодами, без участников и оценок", async () => {
    const source = (await admin.post("/competitions", { name: "Кубок весны", discipline: "WAG" }).expect(201)).body;
    const id = source.id as string;
    await admin
      .post(`/competitions/${id}/gymnasts/import`, { rows: [{ bib: 1, lastName: "Абрамова", firstName: "Анна", category: "КМС" }] })
      .expect(201);
    const categoryId = (await admin.get(`/competitions/${id}/categories`).expect(200)).body[0].id;
    await admin.put(`/competitions/${id}/normatives`, { categories: [{ categoryId, levels: [{ name: "КМС", min: 48 }] }] }).expect(200);
    await admin.put(`/competitions/${id}/rules`, { rules: "FIG", vaultRule: "BEST" }).expect(200);
    const officials = { chiefJudge: { name: "Смирнова О. В.", category: "ВК" }, chiefSecretary: null };
    await admin.put(`/competitions/${id}/officials`, officials).expect(200);
    const old = (await admin.post(`/competitions/${id}/judges`, { name: "Орлова Н.", apparatus: "BB", role: "SUPERVISOR", seat: 1, enterAllMarks: true }).expect(201)).body;
    await admin.post(`/competitions/${id}/judges`, { name: "Лебедева Т.", category: "1К", apparatus: "BB", role: "E", seat: 1 }).expect(201);

    await api(app).post(`/competitions/${id}/copy`, { name: "Кубок осени" }).expect(401);
    const [copy, ...rest] = (await admin.post(`/competitions/${id}/copy`, { name: "Кубок осени" }).expect(201)).body;
    expect(rest).toEqual([]);
    expect(copy).toMatchObject({ name: "Кубок осени", discipline: "WAG", officials });
    expect(copy.id).not.toBe(id);

    const rules = (await admin.get(`/competitions/${copy.id}/rules`).expect(200)).body;
    expect(rules.vaultRule).toBe("BEST");
    const cats = (await admin.get(`/competitions/${copy.id}/categories`).expect(200)).body;
    expect(cats.map((c: { name: string }) => c.name)).toEqual(["КМС"]);
    expect((await admin.get(`/competitions/${copy.id}/gymnasts`).expect(200)).body).toEqual([]);

    const judges = (await admin.get(`/competitions/${copy.id}/judges`).expect(200)).body as { name: string; role: string; category: string | null; enterAllMarks: boolean }[];
    expect(judges.map((j) => [j.name, j.role, j.category, j.enterAllMarks]).sort()).toEqual([
      ["Лебедева Т.", "E", "1К", false],
      ["Орлова Н.", "SUPERVISOR", null, true],
    ]);
    // Старый QR-код в новый турнир не пускает: у судей новые коды.
    const me = (await api(app, old.token).get("/me").expect(200)).body;
    expect(me.competitionId ?? me.judge?.competitionId).toBe(id);
    const codes = (await admin.get(`/competitions/${copy.id}/judges/codes`).expect(200)).body as { token: string | null }[];
    expect(codes.every((c) => c.token && c.token !== old.token)).toBe(true);

    const audit = (await admin.get(`/competitions/${copy.id}/audit?group=setup`).expect(200)).body as { text: string }[];
    expect(audit.map((a) => a.text)).toContain("Турнир создан по образцу «Кубок весны»: разрядов — 1, судей — 2");
  });

  it("турнир из двух частей копируется обеими частями", async () => {
    const girls = (await admin.post("/competitions", { name: "Первенство", discipline: "WAG" }).expect(201)).body;
    await admin.post("/competitions", { name: "Первенство", discipline: "MAG", pairWith: girls.id }).expect(201);
    const parts = (await admin.post(`/competitions/${girls.id}/copy`, { name: "Первенство 2027" }).expect(201)).body as {
      discipline: string;
      pairId: string | null;
    }[];
    expect(parts.map((p) => p.discipline).sort()).toEqual(["MAG", "WAG"]);
    expect(parts[0]!.pairId).toBeTruthy();
    expect(parts[0]!.pairId).toBe(parts[1]!.pairId);
  });
});
