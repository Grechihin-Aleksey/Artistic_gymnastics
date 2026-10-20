import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import ExcelJS from "exceljs";
import type request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, api, startApp } from "./helpers";

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGP4z8AARwzEcQCukw/x0F8jngAAAABJRU5ErkJggg==";

let app: INestApplication;
let admin: ReturnType<typeof api>;
let competitionId: string;

beforeAll(async () => {
  ({ app } = await startApp());
  admin = api(app, ADMIN_TOKEN);
  competitionId = (
    await admin
      .post("/competitions", { name: "Первенство города", discipline: "WAG", teamFormat: { roster: 2, perApparatus: 2, counting: 2 } })
      .expect(201)
  ).body.id;
  const rows = [
    { bib: 1, lastName: "Иванова", firstName: "Анна", club: "Тверь", team: "Школа 5", category: "1 юношеский", shift: 1 },
    { bib: 2, lastName: "Петрова", firstName: "Мария", team: "Школа 5", category: "1 юношеский", shift: 1 },
    { bib: 3, lastName: "Сидорова", firstName: "Вера", category: "2 юношеский", shift: 2 },
  ];
  await admin.post(`/competitions/${competitionId}/gymnasts/import`, { rows }).expect(201);
});

afterAll(async () => {
  await app?.close();
});

/** supertest по умолчанию не собирает двоичное тело в Buffer. */
function binary(res: request.Response, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  (res as unknown as NodeJS.ReadableStream).on("data", (c: Buffer) => chunks.push(c));
  (res as unknown as NodeJS.ReadableStream).on("end", () => cb(null, Buffer.concat(chunks)));
}
const file = (path: string) => admin.get(path).buffer(true).parse(binary);

describe("логотип соревнования", () => {
  it("загружается секретариатом и не раздувает список соревнований", async () => {
    await api(app).put(`/competitions/${competitionId}/logo`, { dataUrl: PNG }).expect(401);
    await admin.put(`/competitions/${competitionId}/logo`, { dataUrl: "data:image/gif;base64,R0lGOD" }).expect(400);
    const fake = await admin
      .put(`/competitions/${competitionId}/logo`, { dataUrl: "data:image/png;base64,/9j/4AAQSkZJRg==" })
      .expect(400);
    expect(fake.body.message).toContain("PNG или JPEG");
    const saved = (await admin.put(`/competitions/${competitionId}/logo`, { dataUrl: PNG }).expect(200)).body;
    expect(saved.hasLogo).toBe(true);
    expect(saved.logo).toBeUndefined();
    const list = (await api(app).get("/competitions").expect(200)).body;
    expect(list[0]).toMatchObject({ id: competitionId, hasLogo: true });
    expect(list[0].logo).toBeUndefined();
    const image = await api(app).get(`/competitions/${competitionId}/logo`).buffer(true).parse(binary).expect(200);
    expect(image.headers["content-type"]).toBe("image/png");
    expect((image.body as Buffer).subarray(1, 4).toString()).toBe("PNG");
  });

  it("стоит в шапке протоколов", async () => {
    const withLogo = (await file(`/competitions/${competitionId}/protocols/start-list`).expect(200)).body as Buffer;
    expect(withLogo.toString("latin1")).toContain("/Subtype /Image");
    await admin.delete(`/competitions/${competitionId}/logo`).expect(200);
    await api(app).get(`/competitions/${competitionId}/logo`).expect(404);
    const without = (await file(`/competitions/${competitionId}/protocols/start-list`).expect(200)).body as Buffer;
    expect(without.toString("latin1")).not.toContain("/Subtype /Image");
  });
});

describe("документы для зала", () => {
  it("стартовый протокол и судейские ведомости собираются в PDF", async () => {
    for (const path of ["start-list", "sheet/BB", "sheet/VT"]) {
      const res = await file(`/competitions/${competitionId}/protocols/${path}`).expect(200);
      expect(res.headers["content-type"]).toContain("application/pdf");
      expect((res.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");
    }
    await admin.get(`/competitions/${competitionId}/protocols/sheet/HB`).expect(422);
    await api(app).get(`/competitions/${competitionId}/protocols/start-list`).expect(401);
  });

  it("итоги выгружаются в Excel по разрядам", async () => {
    const judge = async (role: string) =>
      (await admin.post(`/competitions/${competitionId}/judges`, { name: role, apparatus: "VT", role, seat: 1 }).expect(201))
        .body.token as string;
    const [d, e, sv] = [await judge("D"), await judge("E"), await judge("SUPERVISOR")];
    const people = (await api(app).get(`/competitions/${competitionId}/gymnasts`).expect(200)).body as { id: string; bib: number }[];
    const perf = (
      await api(app, sv)
        .post(`/competitions/${competitionId}/performances`, { gymnastId: people.find((g) => g.bib === 2)!.id, apparatus: "VT" })
        .expect(201)
    ).body;
    await api(app, d).post("/marks", { id: randomUUID(), performanceId: perf.id, kind: "D", value: 4.2 }).expect(201);
    await api(app, e).post("/marks", { id: randomUUID(), performanceId: perf.id, kind: "E", value: 0.9 }).expect(201);
    await api(app, sv).post(`/performances/${perf.id}/approve`).expect(201);

    const res = await file(`/competitions/${competitionId}/protocols/results.xlsx`).expect(200);
    expect(res.headers["content-disposition"]).toContain("results.xlsx");
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(new Uint8Array(res.body as Buffer).buffer);
    expect(book.worksheets.map((w) => w.name)).toEqual([
      "1 юношеский — многоборье",
      "1 юношеский — снаряды",
      "1 юношеский — команды",
      "2 юношеский — многоборье",
      "2 юношеский — снаряды",
    ]);
    const aa = book.getWorksheet("1 юношеский — многоборье")!;
    expect(aa.getRow(2).values).toContain("Сумма");
    expect((aa.getRow(3).values as unknown[]).slice(1, 7)).toEqual([1, 2, "Петрова", "Мария", "", "Школа 5"]);
    expect(aa.getRow(3).getCell(11).value).toBe(13.3);
  });
});
