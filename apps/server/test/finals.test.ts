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
  competitionId = (await admin.post("/competitions", { name: "Кубок школы", discipline: "WAG" }).expect(201)).body.id;
  const kms = "КМС";
  const rows = [
    { bib: 1, lastName: "Абрамова", firstName: "Анна", club: "Олимп", category: kms },
    { bib: 2, lastName: "Белова", firstName: "Бэлла", club: "Олимп", category: kms },
    { bib: 3, lastName: "Волкова", firstName: "Вера", club: "олимп ", category: kms },
    { bib: 4, lastName: "Глебова", firstName: "Галя", club: "Юность", category: kms },
    { bib: 5, lastName: "Демина", firstName: "Даша", club: "Старт", category: kms },
    { bib: 6, lastName: "Ершова", firstName: "Ева", club: "Старт", category: kms },
    { bib: 7, lastName: "Жукова", firstName: "Жанна", club: "Юность", category: kms },
    { bib: 8, lastName: "Зуева", firstName: "Зоя", category: "1 разряд" },
    { bib: 9, lastName: "Ильина", firstName: "Ира", category: "1 разряд" },
  ];
  for (const g of (await admin.post(`/competitions/${competitionId}/gymnasts/import`, { rows }).expect(201)).body) {
    ids.set(g.bib, g.id);
  }
  for (const apparatus of ["FX", "VT"]) {
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
  // Квалификация: вольные у всех (Е-сбавка 1), опорный — у одной.
  const fx: [number, number][] = [[1, 5], [2, 4.9], [3, 4.8], [4, 4.5], [5, 4.5], [6, 4], [7, 3], [8, 3], [9, 2]];
  for (const [bib, d] of fx) await perform(bib, "FX", d);
  await perform(8, "VT", 3);
});

afterAll(async () => {
  await app?.close();
});

async function perform(bib: number, apparatus: string, d: number, attempt = 1, expected = 201) {
  const tablet = tablets.get(apparatus)!;
  const res = await tablet
    .post(`/competitions/${competitionId}/performances`, { gymnastId: ids.get(bib), apparatus, attempt })
    .expect(expected);
  if (expected !== 201) return res.body;
  return (await tablet.post(`/performances/${res.body.id}/tablet-score`, { d, e: [1] }).expect(201)).body;
}

function binary(res: request.Response, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  (res as unknown as NodeJS.ReadableStream).on("data", (c: Buffer) => chunks.push(c));
  (res as unknown as NodeJS.ReadableStream).on("end", () => cb(null, Buffer.concat(chunks)));
}

const base = () => `/competitions/${competitionId}/finals`;
const bibs = (list: { gymnast: { bib: number } }[]) => list.map((f) => f.gymnast.bib);
type Finals = {
  phase: string;
  started: boolean;
  lists: { apparatus: string; category: { name: string }; finalists: { gymnast: { bib: number }; reserve: boolean; position: number; qualRank: number; qualTotal: number }[] }[];
};
const list = (view: Finals, apparatus: string, category: string) =>
  view.lists.find((l) => l.apparatus === apparatus && l.category.name === category)!.finalists;

describe("финалы на снарядах", () => {
  it("отбирает лучших по разряду: лимит от клуба, равенство на границе, запасные", async () => {
    await api(app).post(base(), { size: 3 }).expect(401);
    const view: Finals = (await admin.post(base(), { size: 3, reserves: 1, perClub: 2 }).expect(201)).body;
    expect(view).toMatchObject({ phase: "QUAL", size: 3, reserves: 1, perClub: 2, started: false });

    const kms = list(view, "FX", "КМС");
    const finalists = kms.filter((f) => !f.reserve);
    // Третья из «Олимпа» не проходит по лимиту, Глебова и Демина делят 4-е место — проходят обе.
    expect(bibs(finalists).sort()).toEqual([1, 2, 4, 5]);
    expect(finalists.map((f) => f.position).sort()).toEqual([1, 2, 3, 4]);
    expect(kms.find((f) => f.gymnast.bib === 4)).toMatchObject({ qualRank: 4, qualTotal: 13.5 });
    expect(bibs(kms.filter((f) => f.reserve))).toEqual([6]);
    expect(bibs(list(view, "FX", "1 разряд"))).toHaveLength(2);
    expect(bibs(list(view, "VT", "1 разряд"))).toEqual([8]);
    expect(view.lists.find((l) => l.apparatus === "VT" && l.category.name === "КМС")).toBeUndefined();

    // Пока финалы не начались, их можно пересобрать.
    const again: Finals = (await admin.post(base(), { size: 2, reserves: 0 }).expect(201)).body;
    expect(bibs(list(again, "FX", "КМС")).sort()).toEqual([1, 2]);
    await admin.post(base(), { size: 3, reserves: 1, perClub: 2 }).expect(201);
  });

  it("в финале вызывают только финалистов, запасной заменяет снявшегося", async () => {
    await admin.post(`${base()}/phase`, { phase: "FINAL" }).expect(201);
    expect((await api(app).get(`/competitions/${competitionId}`).expect(200)).body.phase).toBe("FINAL");

    expect((await perform(3, "FX", 4, 1, 409)).message).toContain("не в финале");
    expect((await perform(6, "FX", 4, 1, 409)).message).toContain("не в финале");

    const before: Finals = (await api(app).get(base()).expect(200)).body;
    const position = list(before, "FX", "КМС").find((f) => f.gymnast.bib === 2)!.position;
    const after: Finals = (await admin.post(`${base()}/FX/replace`, { gymnastId: ids.get(2) }).expect(201)).body;
    const kms = list(after, "FX", "КМС");
    expect(kms.find((f) => f.gymnast.bib === 6)).toMatchObject({ reserve: false, position });
    expect(bibs(kms)).not.toContain(2);
    await admin.post(`${base()}/FX/replace`, { gymnastId: ids.get(1) }).expect(409);

    const final = await perform(1, "FX", 3);
    expect(final).toMatchObject({ stage: "FINAL", score: { total: 12 } });
    await admin.post(`${base()}/FX/replace`, { gymnastId: ids.get(1) }).expect(409);
    await admin.post(base(), { size: 3 }).expect(409);
    expect((await api(app).get(base()).expect(200)).body.started).toBe(true);
  });

  it("финальные оценки идут отдельно от квалификации и многоборья", async () => {
    const results = (stage?: string) =>
      api(app).get(`/competitions/${competitionId}/results/apparatus/FX${stage ? `?stage=${stage}` : ""}`).expect(200);
    expect((await results("final")).body.map((r: { gymnast: { bib: number }; score: { total: number } }) => [r.gymnast.bib, r.score.total])).toEqual([
      [1, 12],
    ]);
    expect((await results()).body[0]).toMatchObject({ gymnast: { bib: 1 }, score: { total: 14 } });
    const aa = (await api(app).get(`/competitions/${competitionId}/results/all-around`).expect(200)).body;
    expect(aa.find((r: { gymnast: { bib: number } }) => r.gymnast.bib === 1).total).toBe(14);

    const snapshot = (await api(app).get(`/competitions/${competitionId}/results/snapshot`).expect(200)).body;
    expect(snapshot.competition.phase).toBe("FINAL");
    const kms = snapshot.categories.find((c: { name: string }) => c.name === "КМС");
    expect(kms.apparatus.FX.map((r: { gymnast: { bib: number } }) => r.gymnast.bib)).toEqual([1]);
  });

  it("опорный прыжок в финале: два прыжка, итог — среднее", async () => {
    await perform(8, "VT", 3);
    await perform(8, "VT", 4, 2);
    const vault = (await api(app).get(`/competitions/${competitionId}/results/apparatus/VT?stage=final`).expect(200)).body;
    expect(vault).toEqual([expect.objectContaining({ score: expect.objectContaining({ total: 12.5 }) })]);
  });

  it("протоколы, ведомости и грамоты финалов", async () => {
    const pdf = async (path: string) => {
      const res = await admin.get(`/competitions/${competitionId}/protocols/${path}`).expect(200);
      expect(res.headers["content-type"]).toContain("application/pdf");
    };
    await pdf("apparatus/FX?stage=final");
    await pdf("sheet/FX?stage=final");
    await pdf("diplomas?kind=apparatus");
    const res = await admin.get(`/competitions/${competitionId}/protocols/results.xlsx`).buffer(true).parse(binary).expect(200);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(new Uint8Array(res.body as Buffer).buffer);
    expect(book.worksheets.map((w) => w.name)).toEqual(expect.arrayContaining(["КМС — финалы", "1 разряд — финалы"]));
  });

  it("возврат к квалификации и проверка открытых выступлений", async () => {
    await tablets.get("FX")!.post(`/competitions/${competitionId}/performances`, { gymnastId: ids.get(4), apparatus: "FX" }).expect(201);
    expect((await admin.post(`${base()}/phase`, { phase: "QUAL" }).expect(409)).body.message).toContain("неутверждённое");
  });
});
