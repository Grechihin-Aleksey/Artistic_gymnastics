import { describe, expect, it } from "vitest";
import type { FinalsView } from "@ag/shared";
import { formatLeft, toLocal } from "./timer";
import { announcerView } from "./Announcer";
import { isRelay, parseRoute, routeHash } from "./route";
import { buildSlides, pageCount, pageRows } from "./slides";
import { clubList, clubResults } from "./club";
import { nextPart } from "./hallSwitch";

describe("адрес табло", () => {
  it("читает соревнование и вид, по умолчанию авто", () => {
    expect(parseRoute("#c=abc&view=BB")).toEqual({ competitionId: "abc", view: "BB" });
    expect(parseRoute("")).toEqual({ competitionId: null, view: "auto" });
    expect(parseRoute(routeHash({ competitionId: "abc", view: "auto" }))).toEqual({
      competitionId: "abc",
      view: "auto",
    });
  });

  it("сохраняет режим встраивания и тему при переключении вида", () => {
    const route = parseRoute("#c=abc&embed=1&theme=light");
    expect(route).toEqual({ competitionId: "abc", view: "auto", embed: true, theme: "light" });
    expect(parseRoute(routeHash({ ...route, view: "aa" }))).toEqual({ ...route, view: "aa" });
    expect(parseRoute("#c=abc&theme=pink").theme).toBeUndefined();
    expect(parseRoute(routeHash({ ...route, view: "BB", category: 2 }))).toEqual({ ...route, view: "BB", category: 2 });
    expect(parseRoute("#c=abc&cat=x").category).toBeUndefined();
  });

  it("на сайте берёт данные у ретранслятора, в зале — у сервера", () => {
    expect(isRelay("/widget/")).toBe(true);
    expect(isRelay("/live/widget/index.html")).toBe(true);
    expect(isRelay("/board/")).toBe(false);
  });
});

describe("слайды большого экрана", () => {
  it("показывает сначала снаряды, затем непустые таблицы по страницам", () => {
    const slides = buildSlides([
      {
        aa: 23,
        teams: 0,
        apparatus: [
          { code: "VT", rows: 4 },
          { code: "UB", rows: 0 },
        ],
      },
      { aa: 2, teams: 1, apparatus: [] },
    ]);
    expect(
      slides.map((s) => [typeof s.kind === "string" ? s.kind : s.kind.apparatus, s.category, s.page, s.pages]),
    ).toEqual([
      ["now", 0, 0, 1],
      ["aa", 0, 0, 3],
      ["aa", 0, 1, 3],
      ["aa", 0, 2, 3],
      ["VT", 0, 0, 1],
      ["aa", 1, 0, 1],
      ["teams", 1, 0, 1],
    ]);
  });

  it("делит таблицу на страницы", () => {
    expect(pageCount(0)).toBe(1);
    expect(pageCount(10)).toBe(1);
    expect(pageCount(11)).toBe(2);
    expect(pageRows([1, 2, 3, 4, 5], 1, 2)).toEqual([3, 4]);
  });
});

describe("мой клуб", () => {
  const g = (id: string, bib: number, lastName: string, club: string | null, categoryId: string | null = "k") => ({
    id,
    bib,
    lastName,
    firstName: "А",
    club,
    teamId: null,
    categoryId,
  });
  const score = (total: number) => ({ d: 4, e: 8, neutral: 0, total });
  const data = {
    competition: { id: "c", name: "Кубок", discipline: "WAG" as const },
    live: [
      { apparatus: "BB" as const, current: { performanceId: "p", attempt: 1, gymnast: g("3", 3, "Волкова", "Олимп ") }, last: null },
      { apparatus: "FX" as const, current: null, last: null },
    ],
    categories: [
      {
        id: "k",
        name: "КМС",
        allAround: [
          { rank: 1, gymnast: g("2", 2, "Белова", "олимп"), total: 25, complete: true, apparatus: {} },
          { rank: 2, gymnast: g("1", 1, "Абрамова", "Старт"), total: 24, complete: true, apparatus: {} },
        ],
        teams: [],
        apparatus: {
          BB: [{ rank: 1, gymnast: g("2", 2, "Белова", "олимп"), score: score(13) }],
          FX: [{ rank: 2, gymnast: g("2", 2, "Белова", "олимп"), score: score(12) }],
        },
      },
    ],
    generatedAt: "2030-01-01T00:00:00Z",
  };

  it("находит клубы без учёта регистра и пробелов", () => {
    expect(clubList(data)).toEqual(["олимп", "Старт"]);
  });

  it("собирает места участников клуба и кто сейчас на снаряде", () => {
    const people = clubResults(data, "ОЛИМП");
    expect(people.map((p) => [p.gymnast.lastName, p.allAround?.rank ?? null, p.apparatus.map((a) => `${a.apparatus}:${a.rank}`), p.now])).toEqual([
      ["Белова", 1, ["BB:1", "FX:2"], null],
      ["Волкова", null, [], "BB"],
    ]);
  });

  it("клуб попадает в адрес", () => {
    expect(parseRoute(routeHash({ competitionId: "abc", view: "club", club: "СШ №1" }))).toEqual({ competitionId: "abc", view: "club", club: "СШ №1" });
  });
});

describe("несколько соревнований в одной рамке", () => {
  it("читает список и номер показанного и собирает адрес обратно", () => {
    const route = parseRoute("#c=girls,boys&i=1&embed=1&theme=dark");
    expect(route).toEqual({ competitionId: "boys", group: ["girls", "boys"], view: "auto", embed: true, theme: "dark" });
    expect(parseRoute(routeHash(route))).toEqual(route);
    expect(parseRoute(routeHash({ ...route, competitionId: "girls" })).competitionId).toBe("girls");
    expect(parseRoute("#c=girls,boys&i=7").competitionId).toBe("girls");
  });
});

describe("части турнира на табло в зале", () => {
  const at = "2026-11-14T12:00:00.000Z";
  const group = ["girls", "boys"];
  it("чередование идёт по кругу только по таймеру", () => {
    const sw = { mode: "auto" as const, every: 30, at };
    expect(nextPart(sw, group, "girls", "timer")).toBe("boys");
    expect(nextPart(sw, group, "boys", "timer")).toBe("girls");
    expect(nextPart(sw, group, "girls", "command")).toBeNull();
  });
  it("выбранная часть выводится по команде и не мешает переключателю", () => {
    const sw = { mode: "show" as const, show: "boys", every: 30, at };
    expect(nextPart(sw, group, "girls", "command")).toBe("boys");
    expect(nextPart(sw, group, "boys", "command")).toBeNull();
    expect(nextPart(sw, group, "girls", "timer")).toBeNull();
    expect(nextPart({ ...sw, show: "other" }, group, "girls", "command")).toBeNull();
  });
  it("без настройки и в режиме «на табло» ничего не меняется", () => {
    expect(nextPart(null, group, "girls", "timer")).toBeNull();
    expect(nextPart({ mode: "board", every: 30, at }, group, "girls", "timer")).toBeNull();
  });
});

describe("экран диктора", () => {
  const g = (id: string, bib: number, lastName: string, categoryId: string | null = "cat") => ({
    id,
    bib,
    firstName: "А",
    lastName,
    club: "Олимп",
    teamId: null,
    categoryId,
  });
  const score = (total: number) => ({ d: 5, e: total - 5, neutral: 0, total });
  const data = {
    competition: { id: "c", name: "Кубок", discipline: "WAG" as const },
    generatedAt: "",
    live: [
      {
        apparatus: "BB" as const,
        current: { performanceId: "p3", attempt: 1, gymnast: g("g3", 103, "Третья") },
        last: { performanceId: "p2", attempt: 1, gymnast: g("g2", 102, "Вторая"), score: score(13), approvedAt: "", eMarks: null },
      },
    ],
    categories: [
      {
        id: "cat",
        name: "КМС",
        teams: [],
        allAround: [{ rank: 4, gymnast: g("g2", 102, "Вторая"), total: 40.5, complete: false, apparatus: {} }],
        apparatus: {
          BB: [
            { rank: 1, gymnast: g("g1", 101, "Первая"), score: score(13.5) },
            { rank: 2, gymnast: g("g2", 102, "Вторая"), score: score(13) },
          ],
        },
      },
    ],
  };
  const people = ["g1", "g2", "g3", "g4", "g5", "g6"].map((id, i) => ({
    ...g(id, 101 + i, `Участница${i + 1}`),
    status: id === "g4" ? ("DNS" as const) : ("ACTIVE" as const),
  }));
  const rotation = { rotation: 0, rotations: 4, shifts: [{ number: 1, startApparatus: "BB" as const, apparatus: "BB" as const, gymnastIds: ["g1", "g2", "g3", "g4", "g5", "g6"] }] };

  it("показывает выступающую, оценку с местами и двух следующих без неявок", () => {
    const [bb] = announcerView(data, rotation, null, people);
    expect(bb!.current?.bib).toBe(103);
    expect(bb!.last).toMatchObject({ total: 13, rank: 2, allAround: { rank: 4, total: 40.5 }, category: "КМС" });
    expect(bb!.next.map((p) => p.bib)).toEqual([105, 106]);
    expect(bb!.idle).toBe(false);
    // Смены на снаряде нет — так и пишем; без смен вообще — все по номерам.
    expect(announcerView(data, { ...rotation, shifts: [{ ...rotation.shifts[0]!, apparatus: "FX" as const }] }, null, people)[0]!.idle).toBe(true);
    expect(announcerView(data, { ...rotation, shifts: [] }, null, people)[0]!.next.map((p) => p.bib)).toEqual([105, 106]);
  });

  it("в финале следующие — по составу финала", () => {
    const finals = {
      phase: "FINAL" as const,
      size: 8,
      reserves: 2,
      perClub: null,
      started: true,
      lists: [
        {
          apparatus: "BB" as const,
          category: { id: "cat", name: "КМС" },
          finalists: [
            { gymnast: g("g6", 106, "Шестая"), reserve: false },
            { gymnast: g("g5", 105, "Пятая"), reserve: true },
          ],
        },
      ],
    } as unknown as FinalsView;
    const [bb] = announcerView({ ...data, competition: { ...data.competition, phase: "FINAL" } }, rotation, finals, people);
    expect(bb!.next.map((p) => p.bib)).toEqual([106]);
    expect(bb!.last?.allAround).toBeNull();
  });
});

describe("таймер на табло", () => {
  it("считает остаток по часам экрана и пишет минуты:секунды", () => {
    expect(toLocal({ label: "Разминка", seconds: 30, remainingMs: 12_000 }, 1000)).toEqual({ label: "Разминка", endsAt: 13_000 });
    expect(toLocal(null)).toBeNull();
    expect(formatLeft(65_000)).toBe("1:05");
    expect(formatLeft(8_200)).toBe("0:09");
    expect(formatLeft(-500)).toBe("0:00");
  });
});

describe("запрос тренера с телефона", () => {
  it("понимает оценку с запятой и с точкой, пустое поле — без оценки", async () => {
    const { parseClaimed } = await import("./CoachInquiry");
    expect(parseClaimed("5,4")).toBe(5.4);
    expect(parseClaimed(" 5.45 ")).toBe(5.45);
    expect(parseClaimed("")).toBeUndefined();
    expect(parseClaimed("abc")).toBeNull();
    expect(parseClaimed("25")).toBeNull();
  });
});

describe("прогноз выхода для тренера", () => {
  it("считает очередь смены и темп снаряда", async () => {
    const { forecastFor, upcoming, DEFAULT_PACE_S } = await import("./forecast");
    const g = (id: string, bib: number) => ({ id, bib, firstName: "А", lastName: id, club: "Олимп", categoryId: null });
    const people = [g("a", 1), g("b", 2), g("c", 3), g("d", 4)];
    const data = {
      competition: { id: "x", name: "x", discipline: "WAG", phase: "QUAL" },
      live: [{ apparatus: "BB", current: { performanceId: "p", attempt: 1, gymnast: people[1] }, last: null }],
      categories: [{ id: null, name: "", allAround: [], teams: [], apparatus: { BB: [{ gymnast: people[0] }] } }],
      generatedAt: "",
    } as never;
    const rotation = { rotation: 0, rotations: 4, shifts: [{ number: 1, startApparatus: "BB", apparatus: "BB", gymnastIds: ["a", "b", "c", "d"] }], pace: { BB: 120 } } as never;
    const now = new Date("2026-11-16T10:00:00Z");
    const queues = upcoming(data, rotation, null, people);
    expect(queues.get("BB")!.queue.map((p) => p.id)).toEqual(["c", "d"]);
    const [f] = forecastFor("d", queues, { BB: 120 }, now);
    // Выступающему сейчас — полтемпа, перед «d» ещё один участник.
    expect(f).toMatchObject({ apparatus: "BB", ahead: 1, minutes: 3 });
    expect(f!.at.toISOString()).toBe("2026-11-16T10:03:00.000Z");
    expect(forecastFor("a", queues, undefined, now)).toEqual([]);
    expect(forecastFor("c", queues, undefined, now)[0]!.minutes).toBe(Math.round(DEFAULT_PACE_S / 2 / 60));
  });
});

describe("голосовой вызов диктора", () => {
  it("объявляет только новое: сначала оценку, потом вызов следующего", async () => {
    const { announcements } = await import("./voice");
    const g = (bib: number, lastName: string) => ({ id: lastName, bib, firstName: "Анна", lastName, club: "Олимп", categoryId: null, teamId: null });
    const live1 = [{ apparatus: "BB", current: { performanceId: "p1", attempt: 1, gymnast: g(101, "Иванова") }, last: null }] as never;
    const first = announcements(null, live1, { on: true, scores: true });
    expect(first.texts).toEqual([]);
    const live2 = [
      {
        apparatus: "BB",
        current: { performanceId: "p2", attempt: 1, gymnast: { ...g(102, "Петрова"), club: null } },
        last: { performanceId: "p1", attempt: 1, gymnast: g(101, "Иванова"), score: { d: 5, e: 8.85, neutral: 0, total: 13.85 }, approvedAt: "", eMarks: null },
      },
    ] as never;
    const second = announcements(first.said, live2, { on: true, scores: true });
    expect(second.texts).toEqual(["Бревно. Номер 101, Иванова Анна: 13,850.", "Бревно. Выступает номер 102, Петрова Анна."]);
    expect(announcements(second.said, live2, { on: true, scores: true }).texts).toEqual([]);
    expect(announcements(first.said, live2, { on: true, scores: false }).texts).toEqual(["Бревно. Выступает номер 102, Петрова Анна."]);
  });
});
