import type { INestApplication } from "@nestjs/common";
import ExcelJS from "exceljs";
import type request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, api, startApp } from "./helpers";

let app: INestApplication;
let admin: ReturnType<typeof api>;
let competitionId: string;

beforeAll(async () => {
  ({ app } = await startApp());
  admin = api(app, ADMIN_TOKEN);
  competitionId = (
    await admin
      .post("/competitions", { name: "Первенство школы", discipline: "MAG", rules: "CUSTOM" })
      .expect(201)
  ).body.id;
});

afterAll(async () => {
  await app?.close();
});

function binary(res: request.Response, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  (res as unknown as NodeJS.ReadableStream).on("data", (c: Buffer) => chunks.push(c));
  (res as unknown as NodeJS.ReadableStream).on("end", () => cb(null, Buffer.concat(chunks)));
}

async function xlsx(rows: (string | number)[][]): Promise<string> {
  const book = new ExcelJS.Workbook();
  const ws = book.addWorksheet("Заявка");
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await book.xlsx.writeBuffer()).toString("base64");
}

describe("заявка из Excel", () => {
  it("узнаёт столбцы по заголовкам и раздаёт номера по порядку", async () => {
    const file = await xlsx([
      ["Заявка на участие"],
      [],
      ["№ п/п", "Ф.И.О.", "Год рождения", "Организация", "Разряд", "Тренер"],
      [1, "Смирнов  Илья Петрович", 2015, "ДЮСШ №2", "2 юношеский", "Козлов"],
      [2, "Попов Егор", 2015, "ДЮСШ №2", "2 юношеский", "Козлов"],
      [3, "Безымянный", 2016, "ДЮСШ №2", "2 юношеский", ""],
    ]);
    await api(app).post(`/competitions/${competitionId}/gymnasts/parse-xlsx`, { file }).expect(401);
    const parsed = (await admin.post(`/competitions/${competitionId}/gymnasts/parse-xlsx`, { file, nextBib: 5 }).expect(201))
      .body;
    expect(parsed.text.split("\n")).toEqual([
      "5\tСмирнов\tИлья\tДЮСШ №2\t\t2 юношеский\t",
      "6\tПопов\tЕгор\tДЮСШ №2\t\t2 юношеский\t",
    ]);
    expect(parsed.notes.join(" ")).toContain("выданы по порядку с №5");
    expect(parsed.notes.join(" ")).toContain("строка 6");
  });

  it("берёт стартовые номера, команды и смены из файла", async () => {
    const file = await xlsx([
      ["Стартовый номер", "Фамилия", "Имя", "Клуб", "Команда", "Разряд", "Смена"],
      [11, "Орлов", "Лев", "СШ Ржев", "Ржев", "1 юношеский", "Смена 1"],
      [12, "Волков", "Егор", "СШ Ржев", "Ржев", "1 юношеский", 1],
    ]);
    const parsed = (await admin.post(`/competitions/${competitionId}/gymnasts/parse-xlsx`, { file }).expect(201)).body;
    expect(parsed).toMatchObject({ count: 2, notes: [] });
    expect(parsed.text).toBe("11\tОрлов\tЛев\tСШ Ржев\tРжев\t1 юношеский\t1\n12\tВолков\tЕгор\tСШ Ржев\tРжев\t1 юношеский\t1");
  });

  it("объясняет, если файл не подходит", async () => {
    const noHeader = await xlsx([["a", "b"], [1, 2]]);
    const res = await admin.post(`/competitions/${competitionId}/gymnasts/parse-xlsx`, { file: noHeader }).expect(400);
    expect(res.body.message).toContain("Фамилия");
    const junk = Buffer.from("not an excel file").toString("base64");
    expect((await admin.post(`/competitions/${competitionId}/gymnasts/parse-xlsx`, { file: junk }).expect(400)).body.message).toContain(
      ".xlsx",
    );
  });

  it("отдаёт бланк заявки, который сам же и читает", async () => {
    const template = await api(app)
      .get(`/competitions/${competitionId}/entries-template.xlsx`)
      .buffer(true)
      .parse(binary)
      .expect(200);
    const file = (template.body as Buffer).toString("base64");
    const parsed = (await admin.post(`/competitions/${competitionId}/gymnasts/parse-xlsx`, { file }).expect(201)).body;
    expect(parsed.count).toBe(2);
  });
});

describe("свои правила судейства", () => {
  const people = new Map<number, string>();
  let judge: ReturnType<typeof api>;
  let categories: { id: string; name: string }[];

  beforeAll(async () => {
    const rows = [
      { bib: 1, lastName: "Иванов", firstName: "Пётр", club: "Тверь", category: "1 юношеский" },
      { bib: 2, lastName: "Петров", firstName: "Иван", club: "Тверь", category: "1 юношеский" },
      { bib: 3, lastName: "Сидоров", firstName: "Олег", club: "Ржев", category: "2 юношеский" },
      { bib: 4, lastName: "Козлов", firstName: "Ян", club: "Ржев" },
    ];
    for (const g of (await admin.post(`/competitions/${competitionId}/gymnasts/import`, { rows }).expect(201)).body) {
      people.set(g.bib, g.id);
    }
    categories = (await api(app).get(`/competitions/${competitionId}/rules`).expect(200)).body.categories;
  });

  const tablet = async () => {
    const sv = (
      await admin
        .post(`/competitions/${competitionId}/judges`, { name: "Старший", apparatus: "HB", role: "SUPERVISOR", seat: 1, enterAllMarks: true })
        .expect(201)
    ).body.token as string;
    for (const seat of [1, 2, 3]) {
      await admin.post(`/competitions/${competitionId}/judges`, { name: `E${seat}`, apparatus: "HB", role: "E", seat }).expect(201);
    }
    return api(app, sv);
  };

  /** Вызов участника и оценки с планшета снаряда; ответ на ввод оценок. */
  const score = async (judge: ReturnType<typeof api>, bib: number, body: object, status: number) => {
    const perf = (
      await judge.post(`/competitions/${competitionId}/performances`, { gymnastId: people.get(bib), apparatus: "HB" }).expect(201)
    ).body;
    return (await judge.post(`/performances/${perf.id}/tablet-score`, body).expect(status)).body;
  };

  it("задаются секретариатом: база по разряду и на отдельных снарядах, список сбавок", async () => {
    const [first, second] = categories;
    const body = {
      rules: "CUSTOM",
      deductions: [
        { name: "Отсутствие элемента", value: 1 },
        { name: "Неполное выполнение", value: 0.5 },
      ],
      bases: [
        { categoryId: first!.id, base: 10, apparatus: { HB: 9.5 } },
        { categoryId: second!.id, base: 9 },
      ],
    };
    await api(app).put(`/competitions/${competitionId}/rules`, body).expect(401);
    await admin
      .put(`/competitions/${competitionId}/rules`, { ...body, bases: [{ categoryId: first!.id, base: 10, apparatus: { UB: 9 } }] })
      .expect(400);
    const view = (await admin.put(`/competitions/${competitionId}/rules`, body).expect(200)).body;
    expect(view).toMatchObject({
      rules: "CUSTOM",
      scored: false,
      deductions: body.deductions,
      categories: [
        { name: "1 юношеский", base: 10, apparatus: { HB: 9.5 }, scored: false },
        { name: "2 юношеский", base: 9, apparatus: {}, scored: false },
      ],
    });
    const listed = (await api(app).get(`/competitions/${competitionId}`).expect(200)).body;
    expect(listed).toMatchObject({ rules: "CUSTOM", deductions: body.deductions });
  });

  it("считают итог от базы разряда: база − требования − средняя сбавка E − нейтральная", async () => {
    judge = await tablet();
    // База на перекладине 9.5; сбавки E 0.3, 0.5, 0.4 → средняя без крайних 0.4.
    const approved = await score(judge, 1, { d: 0.5, e: [0.3, 0.5, 0.4], neutral: 0.1 }, 201);
    expect(approved.score).toEqual({ d: 9, e: -0.4, neutral: 0.1, total: 8.5 });
    // Без судьи D сбавки за требования записываются за старшим судьёй.
    expect(approved.marks.filter((m: { kind: string }) => m.kind === "D")).toEqual([
      expect.objectContaining({ role: "SUPERVISOR", value: 0.5 }),
    ]);
    // 2 юношеский: база 9, требований нет.
    expect((await score(judge, 3, { d: 0, e: [0.2, 0.2, 0.2] }, 201)).score.total).toBe(8.8);
  });

  it("не утверждают оценку без базы и объясняют почему", async () => {
    const res = await score(judge, 4, { d: 0, e: [0.1, 0.1, 0.1] }, 409);
    expect(res.message).toContain("не указан разряд");
  });

  it("после первых оценок не дают сменить правила и базу разряда с оценками", async () => {
    const view = (await api(app).get(`/competitions/${competitionId}/rules`).expect(200)).body;
    expect(view.scored).toBe(true);
    const [first, second] = view.categories;
    await admin.put(`/competitions/${competitionId}/rules`, { rules: "FIG" }).expect(409);
    const changed = await admin
      .put(`/competitions/${competitionId}/rules`, { rules: "CUSTOM", bases: [{ categoryId: first.id, base: 9.8 }] })
      .expect(409);
    expect(changed.body.message).toContain("1 юношеский");
    // Те же значения и пополнение списка сбавок — можно.
    await admin
      .put(`/competitions/${competitionId}/rules`, {
        rules: "CUSTOM",
        deductions: [{ name: "Падение с снаряда", value: 1 }],
        bases: [
          { categoryId: first.id, base: 10, apparatus: { HB: 9.5 } },
          { categoryId: second.id, base: 9 },
        ],
      })
      .expect(200);
  });

  it("показывают стоимость и сбавку в протоколах и на табло", async () => {
    const snapshot = (await api(app).get(`/competitions/${competitionId}/results/snapshot`).expect(200)).body;
    expect(snapshot.competition.rules).toBe("CUSTOM");
    const pdf = await admin
      .get(`/competitions/${competitionId}/protocols/apparatus/HB`)
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");
    const book = new ExcelJS.Workbook();
    const res = await admin.get(`/competitions/${competitionId}/protocols/results.xlsx`).buffer(true).parse(binary).expect(200);
    await book.xlsx.load(new Uint8Array(res.body as Buffer).buffer);
    const sheet = book.worksheets.find((w) => w.name.startsWith("1 юношеский — снаряды"))!;
    const values: unknown[][] = [];
    sheet.eachRow((row) => values.push(row.values as unknown[]));
    expect(values.find((v) => v.includes("Стоимость"))).toBeTruthy();
    // Сбавка в таблице — положительное число.
    expect(values.find((v) => v.includes("Иванов"))).toEqual(expect.arrayContaining([9, 0.4, 0.1, 8.5]));
  });
});

describe("грамоты", () => {
  it("печатаются призёрам по разрядам", async () => {
    for (const kind of ["all-around", "apparatus"]) {
      const res = await admin
        .get(`/competitions/${competitionId}/protocols/diplomas?kind=${kind}`)
        .buffer(true)
        .parse(binary)
        .expect(200);
      expect((res.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");
    }
    await admin.get(`/competitions/${competitionId}/protocols/diplomas?kind=other`).expect(400);
    await api(app).get(`/competitions/${competitionId}/protocols/diplomas`).expect(401);
  });
});

