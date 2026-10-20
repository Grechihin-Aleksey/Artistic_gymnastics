import { describe, expect, it } from "vitest";
import { isRelay, parseRoute, routeHash } from "./route";
import { buildSlides, pageCount, pageRows } from "./slides";
import { clubList, clubResults } from "./club";

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
