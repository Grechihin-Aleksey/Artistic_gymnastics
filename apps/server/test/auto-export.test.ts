import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AutoExportService, exportFileName } from "../src/competitions/auto-export.service";
import { ADMIN_TOKEN, api, startApp } from "./helpers";

let app: INestApplication;
let admin: ReturnType<typeof api>;
let auto: AutoExportService;
const dir = mkdtempSync(join(tmpdir(), "ag-export-"));

beforeAll(async () => {
  ({ app } = await startApp({ exportDir: dir }));
  admin = api(app, ADMIN_TOKEN);
  auto = app.get(AutoExportService);
});

afterAll(async () => {
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("автовыгрузка турниров в папку", () => {
  it("называет файл по турниру без знаков, запрещённых в Windows", () => {
    expect(exportFileName('Кубок "Звёзды": 1/2', "0123456789abcdef")).toBe("Кубок _Звёзды__ 1_2 (01234567).json");
  });

  it("сохраняет турнир файлом, который загружается кнопкой «Загрузить турнир из файла»", async () => {
    const { id } = (await admin.post("/competitions", { name: "Первенство города", discipline: "WAG" }).expect(201)).body;
    await admin.post(`/competitions/${id}/gymnasts/import`, { rows: [{ bib: 1, lastName: "Орлова", firstName: "Лиза", club: "СШ" }] }).expect(201);

    const saved = await auto.run();
    expect(saved).toEqual([exportFileName("Первенство города", id)]);
    expect(readdirSync(dir)).toEqual(saved);
    const file = JSON.parse(readFileSync(join(dir, saved[0]!), "utf8")) as { data: { gymnasts: unknown[] } };
    expect(file).toMatchObject({ format: "ag-competition", version: 1 });
    expect(file.data.gymnasts).toHaveLength(1);

    // Без изменений файл не переписывается, после изменений — переписывается.
    expect(await auto.run()).toEqual([]);
    await admin.post(`/competitions/${id}/gymnasts/import`, { rows: [{ bib: 2, lastName: "Белова", firstName: "Аня", club: "СШ" }] }).expect(201);
    expect(await auto.run()).toEqual(saved);

    // Турнир удалили по ошибке — он возвращается из файла.
    await admin.delete(`/competitions/${id}`).expect(204);
    const again = JSON.parse(readFileSync(join(dir, saved[0]!), "utf8")) as object;
    await admin.post("/competitions/import", again).expect(201);
    expect((await admin.get(`/competitions/${id}/gymnasts`).expect(200)).body).toHaveLength(2);
  });
});
