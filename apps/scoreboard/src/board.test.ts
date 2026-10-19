import { describe, expect, it } from "vitest";
import { isRelay, parseRoute, routeHash } from "./route";
import { buildSlides, pageCount, pageRows } from "./slides";

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
  });

  it("на сайте берёт данные у ретранслятора, в зале — у сервера", () => {
    expect(isRelay("/widget/")).toBe(true);
    expect(isRelay("/live/widget/index.html")).toBe(true);
    expect(isRelay("/board/")).toBe(false);
  });
});

describe("слайды большого экрана", () => {
  it("показывает сначала снаряды, затем непустые таблицы по страницам", () => {
    const slides = buildSlides({
      aa: 23,
      teams: 0,
      apparatus: [
        { code: "VT", rows: 4 },
        { code: "UB", rows: 0 },
      ],
    });
    expect(slides.map((s) => [typeof s.kind === "string" ? s.kind : s.kind.apparatus, s.page, s.pages])).toEqual([
      ["now", 0, 1],
      ["aa", 0, 3],
      ["aa", 1, 3],
      ["aa", 2, 3],
      ["VT", 0, 1],
    ]);
  });

  it("делит таблицу на страницы", () => {
    expect(pageCount(0)).toBe(1);
    expect(pageCount(10)).toBe(1);
    expect(pageCount(11)).toBe(2);
    expect(pageRows([1, 2, 3, 4, 5], 1, 2)).toEqual([3, 4]);
  });
});
