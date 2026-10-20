import { submitMarkSchema, type SubmitMarkInput } from "@ag/shared";
import { describe, expect, it, vi } from "vitest";
import { parsePoints, parseScore } from "./labels";
import { MarkQueue, type SendOutcome } from "./markQueue";
import { parseRoster, teamFormatWarnings } from "./roster";
import { takeTokenFromLocation } from "./token";
import { uuid } from "./uuid";

const mark = (kind: SubmitMarkInput["kind"], value: number, performanceId = "p1"): SubmitMarkInput => ({
  id: uuid(),
  performanceId,
  kind,
  value,
});

describe("очередь оценок", () => {
  it("хранит оценки, пока нет связи, и отправляет их, когда связь вернулась", async () => {
    let online = false;
    const sent: SubmitMarkInput[] = [];
    const send = vi.fn(async (m: SubmitMarkInput): Promise<SendOutcome> => {
      if (!online) return { status: "retry" };
      sent.push(m);
      return { status: "ok" };
    });
    const queue = new MarkQueue(localStorage, "q1", send);
    queue.enqueue(mark("E", 1.3));
    await queue.flush();
    expect(queue.items()).toHaveLength(1);

    // перезагрузка страницы: новая очередь читает то же хранилище
    const reloaded = new MarkQueue(localStorage, "q1", send);
    expect(reloaded.items()).toHaveLength(1);

    online = true;
    await reloaded.flush();
    expect(sent.map((m) => m.value)).toEqual([1.3]);
    expect(reloaded.items()).toHaveLength(0);
  });

  it("новая оценка заменяет неотправленную оценку того же вида", () => {
    const queue = new MarkQueue(localStorage, "q2", async () => ({ status: "retry" }));
    queue.enqueue(mark("D", 5.5));
    queue.enqueue(mark("NEUTRAL", 0.1));
    queue.enqueue(mark("D", 5.6));
    expect(queue.items().map((m) => [m.kind, m.value])).toEqual([
      ["NEUTRAL", 0.1],
      ["D", 5.6],
    ]);
  });

  it("убирает отклонённую сервером оценку и сообщает причину", async () => {
    const queue = new MarkQueue(localStorage, "q3", async () => ({ status: "rejected", reason: "Оценка уже утверждена" }));
    queue.enqueue(mark("E", 1));
    const rejected = await queue.flush();
    expect(rejected.map((r) => r.reason)).toEqual(["Оценка уже утверждена"]);
    expect(queue.items()).toHaveLength(0);
  });

  it("не запускает две отправки одновременно", async () => {
    let calls = 0;
    const queue = new MarkQueue(localStorage, "q4", async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return { status: "ok" };
    });
    queue.enqueue(mark("E", 1));
    await Promise.all([queue.flush(), queue.flush()]);
    expect(calls).toBe(1);
  });
});

describe("ввод оценки", () => {
  it("принимает до трёх знаков после точки и проверяет диапазон", () => {
    expect(parseScore("1.3", "E")).toBe(1.3);
    expect(parseScore("10", "E")).toBe(10);
    expect(parseScore("10.1", "E")).toBeNull();
    expect(parseScore("15.4", "D")).toBe(15.4);
    expect(parseScore("1.", "E")).toBeNull();
    expect(parseScore("", "E")).toBeNull();
    expect(parseScore("0.1234", "NEUTRAL")).toBeNull();
  });
});

describe("вход по QR-коду", () => {
  it("забирает токен из адреса, сохраняет его и очищает адрес", () => {
    history.replaceState(null, "", "/judge/#token=abc%2Bdef");
    expect(takeTokenFromLocation(location, localStorage)).toBe("abc+def");
    expect(location.hash).toBe("");
    expect(takeTokenFromLocation(location, localStorage)).toBe("abc+def");
  });
});

describe("uuid", () => {
  it("проходит проверку сервера", () => {
    for (let i = 0; i < 50; i++) {
      expect(submitMarkSchema.safeParse(mark("E", 1, uuid())).success).toBe(true);
    }
  });
});

describe("список участников из таблицы", () => {
  it("понимает строки из Excel, пропускает заголовок и пустые строки", () => {
    const text = "№\tФамилия\tИмя\tКлуб\tКоманда\n12\tИванова\tАнна\tг. Тверь\tСШОР №1\n\n13\tПетрова\tМария\n";
    expect(parseRoster(text)).toEqual({
      rows: [
        { bib: 12, lastName: "Иванова", firstName: "Анна", club: "г. Тверь", team: "СШОР №1" },
        { bib: 13, lastName: "Петрова", firstName: "Мария" },
      ],
      errors: [],
    });
  });

  it("принимает разделитель «;» и сообщает о строках с ошибками", () => {
    const { rows, errors } = parseRoster("1; Сидорова; Вера; ; Олимп\nВолкова Ксения\n3; Попова");
    expect(rows).toEqual([{ bib: 1, lastName: "Сидорова", firstName: "Вера", team: "Олимп" }]);
    expect(errors).toEqual(["Строка 2: нет номера участника", "Строка 3: нужны фамилия и имя"]);
  });

  it("читает дату рождения, город, тренера и отчество", () => {
    const { rows, errors } = parseRoster(
      "5\tОрлова\tЛиза\tСШ\t\t1 юношеский\t1\t15.03.2014\tТверь\tСмирнова О. В.\tИгоревна\n6\tКимова\tЮля\t\t\t\t\t15 марта",
    );
    expect(rows).toEqual([
      {
        bib: 5,
        lastName: "Орлова",
        firstName: "Лиза",
        club: "СШ",
        category: "1 юношеский",
        shift: 1,
        birthDate: "15.03.2014",
        city: "Тверь",
        coach: "Смирнова О. В.",
        middleName: "Игоревна",
      },
    ]);
    expect(errors).toEqual(["Строка 2: дата рождения — год (2012) или дата (15.03.2012)"]);
  });

  it("читает разряд и смену", () => {
    const { rows, errors } = parseRoster("5\tКозлов\tЯн\t\tШкола 5\t2 юношеский\t3\n6\tОрлов\tЛев\t\t\t\tдве");
    expect(rows).toEqual([
      { bib: 5, lastName: "Козлов", firstName: "Ян", team: "Школа 5", category: "2 юношеский", shift: 3 },
    ]);
    expect(errors).toEqual(["Строка 2: смена должна быть числом от 1 до 50"]);
  });
});

describe("teamFormatWarnings", () => {
  it("warns when a team is bigger than the per-apparatus count or the roster", () => {
    const format = { roster: 5, perApparatus: 4, counting: 3 };
    const out = teamFormatWarnings(
      new Map([
        ["СШОР №1", 4],
        ["Школа 5", 5],
        ["Лицей", 6],
      ]),
      format,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("5-5-3");
    expect(out[1]).toContain("допускается 5");
  });
});

describe("очки общекомандного зачёта", () => {
  it("читает очки через пробел, запятая — десятичный знак", () => {
    expect(parsePoints("10 8  6,5;5")).toEqual([10, 8, 6.5, 5]);
    expect(parsePoints("")).toEqual([]);
    expect(parsePoints("10 -1")).toBeNull();
    expect(parsePoints("1,25")).toBeNull();
    expect(parsePoints("десять")).toBeNull();
  });
});
