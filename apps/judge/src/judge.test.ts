import { eToleranceFor, submitMarkSchema, type InquiryView, type PerformanceView, type RulesView, type SubmitMarkInput } from "@ag/shared";
import { describe, expect, it, vi } from "vitest";
import { addDeduction, eSpreadWarning, expandScore, formatTime, parsePoints, parseScore, restHint, timeLimit } from "./labels";
import { Journal } from "./journal";
import { chiefFlags } from "./ChiefJudge";
import { candidateBases, findServer, handOver } from "./finder";
import { parseTimerInput } from "./Secretariat";
import { MarkQueue, type SendOutcome } from "./markQueue";
import { parseRoster, splitByGender, teamFormatWarnings } from "./roster";
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

describe("быстрый ввод оценки", () => {
  it("без точки первая цифра — целые, остальные — сотые", () => {
    expect(expandScore("9")).toBe("9.00");
    expect(expandScore("95")).toBe("9.50");
    expect(expandScore("955")).toBe("9.55");
    expect(expandScore("9555")).toBe("9.555");
    expect(expandScore("05")).toBe("0.50");
    expect(expandScore(" 3 ")).toBe("3.00");
  });

  it("с точкой или запятой оставляет число как есть", () => {
    expect(expandScore("10.")).toBe("10.00");
    expect(expandScore("10,5")).toBe("10.50");
    expect(expandScore("8.123")).toBe("8.123");
    expect(expandScore("")).toBe("");
    expect(expandScore("95555")).toBe("95555");
  });

  it("развёрнутая оценка проходит проверку, сбавки прибавляются к ней", () => {
    expect(parseScore(expandScore("95"), "E")).toBe(9.5);
    expect(parseScore(expandScore("10."), "E")).toBe(10);
    expect(parseScore(expandScore("95555"), "E")).toBeNull();
    expect(addDeduction("05", 0.3)).toBe("0.8");
  });
});

describe("расхождение сбавок судей E", () => {
  it("молчит в пределах допуска и предупреждает сверх него", () => {
    expect(eSpreadWarning([1.2], 0.5)).toBeNull();
    expect(eSpreadWarning([1.2, 1.7], 0.5)).toBeNull();
    expect(eSpreadWarning([1.2, 1.4, 1.3], 0.5)).toBeNull();
    expect(eSpreadWarning([1.2, 2.0], 0.5)).toBe("Сбавки судей E расходятся на 0.80 (допуск 0.50). Проверьте перед утверждением");
  });

  it("по FIG допуск зависит от оценки E, по своим правилам — одно число", () => {
    // Оценка E 9.6 — верхняя строка таблицы, 8.2 — строка «от 8», 5.0 — «от 0».
    expect(eToleranceFor({ rules: "FIG" }, [0.3, 0.5])).toBe(0.2);
    expect(eToleranceFor({ rules: "FIG" }, [1.7, 1.9])).toBe(0.5);
    expect(eToleranceFor({ rules: "FIG" }, [5, 5])).toBe(0.7);
    // Граница строки входит в неё: E ровно 9.000 — строка «от 9».
    expect(eToleranceFor({ rules: "FIG" }, [1, 1])).toBe(0.3);
    // Своя таблица вместо заложенной.
    const table = [
      { from: 0, tolerance: 1 },
      { from: 9, tolerance: 0.1 },
    ];
    expect(eToleranceFor({ rules: "FIG", eToleranceTable: table }, [0.5])).toBe(0.1);
    expect(eToleranceFor({ rules: "FIG", eToleranceTable: table }, [2])).toBe(1);
    expect(eToleranceFor({ rules: "CUSTOM", eTolerance: 0.8, eToleranceTable: table }, [0.5])).toBe(0.8);
    expect(eToleranceFor({ rules: "CUSTOM" }, [0.5])).toBe(0.5);
    expect(eToleranceFor(null, [0.5])).toBe(0.2);
  });
});

describe("секундомер", () => {
  it("знает предельное время упражнения по правилам FIG", () => {
    expect(timeLimit("WAG", "FX")).toBe(90);
    expect(timeLimit("WAG", "BB")).toBe(90);
    expect(timeLimit("WAG", "VT")).toBeNull();
    expect(timeLimit("MAG", "FX")).toBe(70);
    expect(timeLimit("MAG", "PH")).toBeNull();
  });

  it("показывает минуты, секунды и десятые", () => {
    expect(formatTime(0)).toBe("0:00.0");
    expect(formatTime(65_340)).toBe("1:05.3");
    expect(formatTime(90_000)).toBe("1:30.0");
  });
});

describe("подсказка на снаряде без смены", () => {
  const shift = (number: number, startApparatus: "VT" | "UB" | "BB" | "FX", apparatus: "VT" | "UB" | "BB" | "FX") => ({
    number,
    startApparatus,
    apparatus,
    gymnastIds: [],
  });
  it("называет смену и ротацию, когда она придёт на снаряд", () => {
    // Три смены на четырёх снарядах: во 2-й ротации на вольных никого, смена 2 придёт в 3-й.
    const rotation = { rotation: 1, rotations: 4, shifts: [shift(1, "VT", "UB"), shift(2, "UB", "BB"), shift(3, "BB", "VT")] };
    expect(restHint(rotation, "WAG", "FX")).toContain("смена 2 придёт в ротации 3");
  });
  it("говорит, что смен больше не будет", () => {
    const rotation = { rotation: 3, rotations: 4, shifts: [shift(1, "VT", "FX"), shift(2, "UB", "VT")] };
    expect(restHint(rotation, "WAG", "UB")).toContain("больше смен на этом снаряде не будет");
  });
});

describe("список турнира девочек и мальчиков", () => {
  it("делит участников по столбцу «Пол» и не теряет тех, у кого пол не указан", () => {
    const text = ["1\tБелова\tАнна\t\t\t\t\t\t\t\t\tЖ", "2\tОрлов\tЛев\t\t\t\t\t\t\t\t\tм", "3\tКим\tСаша"].join("\n");
    const parsed = parseRoster(text);
    expect(parsed.errors).toEqual([]);
    const split = splitByGender(parsed.rows);
    expect(split.girls.map((r) => r.lastName)).toEqual(["Белова"]);
    expect(split.boys.map((r) => r.lastName)).toEqual(["Орлов"]);
    expect(split.missing).toEqual([3]);
    expect("gender" in split.girls[0]!).toBe(false);
  });
  it("не принимает непонятный пол", () => {
    expect(parseRoster("1\tБелова\tАнна\t\t\t\t\t\t\t\t\tX").errors[0]).toContain("пол");
  });
});

describe("журнал оценок на планшете", () => {
  const view = (gymnastId: string, status: "APPROVED" | "SCORING", value = 5): PerformanceView => ({
    id: `p-${gymnastId}`,
    competitionId: "c",
    gymnastId,
    apparatus: "BB",
    attempt: 1,
    stage: "QUAL",
    status,
    score: null,
    marks: [{ judgeId: "j1", seat: 1, role: "D", kind: "D", value }],
  });

  it("помнит только утверждённые выступления и обновляет исправленные", () => {
    let now = 1_000_000;
    const journal = new Journal(localStorage, "c1", "BB", () => now);
    journal.remember([view("g1", "APPROVED"), view("g2", "SCORING")]);
    journal.remember([view("g1", "APPROVED", 5.5)]);
    expect(journal.all()).toEqual([
      { gymnastId: "g1", apparatus: "BB", attempt: 1, stage: "QUAL", marks: [{ judgeId: "j1", kind: "D", value: 5.5 }] },
    ]);
    // Удаление выступления на сервере (откат базы) журнал не трогает.
    journal.remember([]);
    expect(new Journal(localStorage, "c1", "BB", () => now).all()).toHaveLength(1);
    // Через неделю забывает.
    now += 8 * 24 * 3600 * 1000;
    expect(new Journal(localStorage, "c1", "BB", () => now).all()).toEqual([]);
  });
});

describe("время таймера на табло", () => {
  it("понимает минуты:секунды и просто секунды", () => {
    expect(parseTimerInput("0:30")).toBe(30);
    expect(parseTimerInput("10:00")).toBe(600);
    expect(parseTimerInput("90")).toBe(90);
    expect(parseTimerInput("1:5")).toBeNull();
    expect(parseTimerInput("полминуты")).toBeNull();
  });
});

describe("поиск сервера по новому адресу", () => {
  it("перебирает соседние адреса той же сети, ближние сначала", () => {
    const list = candidateBases("http://192.168.1.23:3000");
    expect(list.slice(0, 4)).toEqual([
      "http://192.168.1.24:3000",
      "http://192.168.1.22:3000",
      "http://192.168.1.25:3000",
      "http://192.168.1.21:3000",
    ]);
    expect(list).toHaveLength(253);
    expect(list).not.toContain("http://192.168.1.23:3000");
    expect(candidateBases("http://gym.local:3000")).toEqual([]);
  });

  it("находит сервер, который принимает код судьи, и досылает оценки", async () => {
    const calls: string[] = [];
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url === "http://10.0.0.7:3000/me") return new Response("{}", { status: 200 });
      if (url.endsWith("/me")) return new Response("{}", { status: 401 });
      return new Response("{}", { status: 201 });
    }) as typeof fetch;
    const base = await findServer(["http://10.0.0.5:3000", "http://10.0.0.7:3000"], "t", "d", fake);
    expect(base).toBe("http://10.0.0.7:3000");
    calls.length = 0;
    await handOver(base!, "t", "d", [{ id: uuid(), performanceId: uuid(), kind: "E", value: 1 }], [
      { gymnastId: uuid(), apparatus: "BB", attempt: 1, stage: "QUAL", marks: [{ judgeId: uuid(), kind: "E", value: 1 }] },
    ], fake);
    expect(calls).toEqual(["POST http://10.0.0.7:3000/recovery", "POST http://10.0.0.7:3000/marks"]);
  });

  it("код входа с прежнего адреса приносит с собой метку планшета", () => {
    const storage = new Map<string, string>();
    const fakeStorage = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v) } as Storage;
    history.replaceState(null, "", "/judge/#token=abc&device=dev-1");
    expect(takeTokenFromLocation(location, fakeStorage)).toBe("abc");
    expect(storage.get("device-id")).toBe("dev-1");
  });
});

describe("экран главного судьи", () => {
  const perf = (over: Partial<PerformanceView>): PerformanceView => ({
    id: uuid(),
    competitionId: "c",
    gymnastId: "g1",
    apparatus: "BB",
    attempt: 1,
    stage: "QUAL",
    status: "APPROVED",
    score: { d: 5, e: 8.5, neutral: 0, total: 13.5 },
    marks: [],
    calledAt: "2026-11-16T10:00:00Z",
    approvedAt: "2026-11-16T10:01:00Z",
    ...over,
  });
  const e = (...values: number[]) => values.map((value, i) => ({ judgeId: `e${i}`, seat: i + 1, role: "E" as const, kind: "E" as const, value }));
  const now = new Date("2026-11-16T10:05:00Z").getTime();

  it("отмечает расхождение E сверх допуска, долгую оценку, нейтральную сбавку и запрос тренера", () => {
    const flags = chiefFlags(
      [
        perf({ marks: e(1.0, 1.2) }),
        perf({ gymnastId: "g2", marks: e(1.0, 1.9), score: { d: 5, e: 8.55, neutral: 0.1, total: 13.45 } }),
        perf({ gymnastId: "g3", status: "SCORING", score: null, calledAt: "2026-11-16T10:02:00Z", approvedAt: null }),
      ],
      [{ id: "i", competitionId: "c", performanceId: "p", apparatus: "BB", attempt: 1, gymnast: { id: "g1" } as never, coach: "Смирнова", claimedD: null, previousD: 5, newD: null, status: "PENDING", late: false } as unknown as InquiryView],
      { rules: "CUSTOM", eTolerance: 0.5 } as RulesView,
      now,
    );
    expect(flags.map((f) => [f.kind, f.gymnastId])).toEqual([
      ["inquiry", "g1"],
      ["slow", "g3"],
      ["spread", "g2"],
      ["neutral", "g2"],
    ]);
    expect(flags[1]!.text).toBe("оценку ставят уже 3 мин");
  });
});
