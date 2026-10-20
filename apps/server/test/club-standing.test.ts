import type { INestApplication } from "@nestjs/common";
import ExcelJS from "exceljs";
import type request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, api, startApp } from "./helpers";

let app: INestApplication;
let admin: ReturnType<typeof api>;
let competitionId: string;
const ids = new Map<number, string>();
const tablets = new Map<string, ReturnType<typeof api>>();

beforeAll(async () => {
  ({ app } = await startApp());
  admin = api(app, ADMIN_TOKEN);
  competitionId = (
    await admin
      .post("/competitions", { name: "Кубок клубов", discipline: "WAG", teamFormat: { roster: 2, perApparatus: 2, counting: 2 } })
      .expect(201)
  ).body.id;
  // Клуб «олимп » у третьей участницы записан иначе — это тот же клуб.
  const rows = [
    { bib: 1, lastName: "Абрамова", firstName: "Анна", club: "Олимп", team: "Олимп" },
    { bib: 2, lastName: "Белова", firstName: "Бэлла", club: "Олимп", team: "Олимп" },
    { bib: 3, lastName: "Волкова", firstName: "Вера", club: "олимп " },
    { bib: 4, lastName: "Глебова", firstName: "Галя", club: "Старт", team: "Старт" },
    { bib: 5, lastName: "Демина", firstName: "Даша", club: "Старт", team: "Старт" },
    { bib: 6, lastName: "Ершова", firstName: "Ева", club: "Юность" },
  ];
  for (const g of (await admin.post(`/competitions/${competitionId}/gymnasts/import`, { rows }).expect(201)).body) {
    ids.set(g.bib, g.id);
  }
  for (const apparatus of ["VT", "UB", "BB", "FX"]) {
    const token = (
      await admin
        .post(`/competitions/${competitionId}/judges`, { name: "СС", apparatus, role: "SUPERVISOR", seat: 1, enterAllMarks: true })
        .expect(201)
    ).body.token as string;
    for (const role of ["D", "E"]) {
      await admin.post(`/competitions/${competitionId}/judges`, { name: role, apparatus, role, seat: 1 }).expect(201);
    }
    tablets.set(apparatus, api(app, token));
  }
  // Места везде совпадают с номерами: 1-я лучше всех, 6-я хуже всех.
  const d: Record<number, number> = { 1: 5, 2: 4, 3: 3, 4: 2, 5: 1, 6: 0.5 };
  for (const [apparatus, tablet] of tablets) {
    for (const [bib, value] of Object.entries(d)) {
      const perf = (
        await tablet.post(`/competitions/${competitionId}/performances`, { gymnastId: ids.get(Number(bib)), apparatus }).expect(201)
      ).body;
      await tablet.post(`/performances/${perf.id}/tablet-score`, { d: value, e: [1] }).expect(201);
    }
  }
});

afterAll(async () => {
  await app?.close();
});

function binary(res: request.Response, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  (res as unknown as NodeJS.ReadableStream).on("data", (c: Buffer) => chunks.push(c));
  (res as unknown as NodeJS.ReadableStream).on("end", () => cb(null, Buffer.concat(chunks)));
}

const setPoints = (body: object) => admin.put(`/competitions/${competitionId}/club-standing`, body);
const standing = async () => (await api(app).get(`/competitions/${competitionId}/results/clubs`).expect(200)).body;

describe("общекомандный зачёт", () => {
  it("без таблицы очков зачёт пуст, а менять её может только секретариат", async () => {
    expect(await standing()).toEqual({ settings: { allAround: [], apparatus: [], teams: [], best: null }, rows: [] });
    await api(app).put(`/competitions/${competitionId}/club-standing`, { allAround: [], apparatus: [], teams: [], best: null }).expect(401);
    const bad = await setPoints({ allAround: [-1], apparatus: [], teams: [], best: null }).expect(400);
    expect(bad.body.issues[0].path).toBe("allAround.0");
  });

  it("складывает очки за многоборье, снаряды и команды с лимитом лучших от клуба", async () => {
    await setPoints({ allAround: [10, 8, 6, 5, 4, 3], apparatus: [3, 2, 1], teams: [5, 3], best: 2 }).expect(200);
    const { rows } = await standing();
    // Олимп: многоборье 10+8 (третья не в зачёте), снаряды (3+2+1)×4, команда 5.
    expect(rows).toEqual([
      { rank: 1, club: "Олимп", total: 47, allAround: 18, apparatus: 24, teams: 5, places: [6, 5, 4] },
      { rank: 2, club: "Старт", total: 12, allAround: 9, apparatus: 0, teams: 3, places: [0, 1, 0] },
      { rank: 3, club: "Юность", total: 3, allAround: 3, apparatus: 0, teams: 0, places: [0, 0, 0] },
    ]);
  });

  it("при равенстве очков выше клуб с бо́льшим числом первых мест", async () => {
    await setPoints({ allAround: [], apparatus: [], teams: [1, 1], best: null }).expect(200);
    const { rows } = await standing();
    expect(rows.map((r: { rank: number; club: string; total: number }) => [r.rank, r.club, r.total])).toEqual([
      [1, "Олимп", 1],
      [2, "Старт", 1],
    ]);
  });

  it("протокол зачёта в PDF и на листе Excel", async () => {
    await setPoints({ allAround: [10, 8, 6, 5, 4, 3], apparatus: [], teams: [], best: null }).expect(200);
    const res = await admin.get(`/competitions/${competitionId}/protocols/clubs`).expect(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    const xlsx = await admin.get(`/competitions/${competitionId}/protocols/results.xlsx`).buffer(true).parse(binary).expect(200);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(new Uint8Array(xlsx.body as Buffer).buffer);
    const sheet = book.getWorksheet("Общекомандный зачёт")!;
    const values = sheet.getSheetValues().flat().map(String);
    expect(values).toEqual(expect.arrayContaining(["Олимп", "24", "Старт", "9", "Юность", "3"]));
  });
});
