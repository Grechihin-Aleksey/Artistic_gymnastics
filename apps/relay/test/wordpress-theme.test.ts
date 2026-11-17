import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const hasPhp = spawnSync("php", ["-v"]).status === 0;
const THEME = join(__dirname, "..", "wordpress", "ag-federation");

/** Функции темы без WordPress: только то, что не трогает базу. */
function run(body: string, today = "2026-11-17") {
  const code = `
    define('ABSPATH', '/'); define('DAY_IN_SECONDS', 86400); define('MINUTE_IN_SECONDS', 60); define('HOUR_IN_SECONDS', 3600);
    function add_action() {} function add_filter() {}
    function wp_date($f, $t = null) { return date($f, $t ?? strtotime(${JSON.stringify(today)} . ' 12:00:00')); }
    function wp_strip_all_tags($s) { return strip_tags((string) $s); }
    require ${JSON.stringify(join(THEME, "inc", "helpers.php"))};
    require ${JSON.stringify(join(THEME, "inc", "components.php"))};
    require ${JSON.stringify(join(THEME, "inc", "archive.php"))};
    require ${JSON.stringify(join(THEME, "inc", "sections.php"))};
    require ${JSON.stringify(join(THEME, "inc", "ical.php"))};
    ${body}
  `;
  const out = spawnSync("php", ["-r", code], { encoding: "utf8" });
  if (out.status !== 0) throw new Error(out.stderr || out.stdout);
  return JSON.parse(out.stdout);
}

describe.skipIf(!hasPhp)("тема WordPress", () => {
  it("даты соревнований по-русски", () => {
    expect(
      run(`echo json_encode([
        ag_date_range('2026-12-05', '2026-12-07'), ag_date_range('2026-11-30', '2026-12-02'),
        ag_date_range('2027-01-20', '2027-01-24'), ag_date_range('2026-12-31', '2027-01-02'), ag_date_range('2026-12-20', ''),
        ag_date_badge('2026-11-30', '2026-12-02'), ag_days_until('2026-12-05'), ag_days_until('2026-11-18'), ag_days_until('2026-11-19'),
      ]);`),
    ).toEqual([
      "5–7 декабря", "30 ноября – 2 декабря", "20–24 января 2027", "31 декабря 2026 – 2 января 2027", "20 декабря",
      ["30–2", "ноя – дек"], "через 18 дней", "завтра", "через 2 дня",
    ]);
  });

  it("расписание группы: дни с одинаковым временем склеиваются", () => {
    const rows = [
      { day: 1, from: "08:30", to: "11:30", place: "" }, { day: 1, from: "16:00", to: "18:00", place: "" },
      { day: 2, from: "08:30", to: "11:30", place: "" }, { day: 3, from: "08:30", to: "11:30", place: "" },
      { day: 3, from: "16:00", to: "18:00", place: "" }, { day: 4, from: "08:30", to: "11:30", place: "" },
      { day: 5, from: "08:30", to: "11:30", place: "" }, { day: 5, from: "16:00", to: "18:00", place: "" },
      { day: 6, from: "10:00", to: "", place: "" },
    ];
    expect(run(`echo json_encode([ag_schedule_summary(json_decode(${JSON.stringify(JSON.stringify(rows))}, true)), ag_days_label([2, 4]), ag_days_label([6, 7]), ag_weekday_today()]);`)).toEqual([
      "Пн–Пт 08:30–11:30 · Пн, Ср, Пт 16:00–18:00 · Сб 10:00", "Вт, Чт", "Сб, Вс", 2,
    ]);
  });

  it("календарь iCal: экранирование и перенос длинных строк по 75 байт без разрыва букв", () => {
    const [text, folded] = run(`echo json_encode([ag_ical_text("Кубок; этап 1, финал\nвторая строка"), ag_ical_fold('SUMMARY:' . str_repeat('Гимнастика ', 12))]);`);
    expect(text).toBe("Кубок\\; этап 1\\, финал\\nвторая строка");
    const lines = (folded as string).split("\r\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(Buffer.byteLength(l)).toBeLessThanOrEqual(76);
    expect(lines.map((l, i) => (i ? l.slice(1) : l)).join("")).toBe("SUMMARY:" + "Гимнастика ".repeat(12));
  });

  it("стадия по датам и ручная", () => {
    const stage = (start: string, end: string, o = "") => `ag_stage(['start' => '${start}', 'end' => '${end}', 'stage_override' => '${o}'])`;
    expect(run(`echo json_encode([${stage("2026-12-05", "2026-12-07")}, ${stage("2026-11-16", "2026-11-18")}, ${stage("2026-11-08", "2026-11-10")}, ${stage("2026-11-08", "2026-11-10", "live")}]);`)).toEqual([
      "before", "live", "done", "live",
    ]);
  });

  it("призёры из снимка: многоборье по разрядам и команды", () => {
    const snap = {
      competition: { id: "x", name: "Т", discipline: "WAG" },
      categories: [
        {
          id: "c1", name: "КМС",
          allAround: [1, 2, 3, 4].map((r) => ({ rank: r, total: 53 - r, complete: true, gymnast: { firstName: "Анна", lastName: `Ф${r}`, club: "Клуб" } })),
          teams: [{ rank: 1, team: { name: "Область" }, total: 150.2 }],
          apparatus: {},
        },
      ],
    };
    const r = run(`echo json_encode(ag_podiums_from_snapshot(json_decode(${JSON.stringify(JSON.stringify(snap))}, true)));`);
    expect(r).toEqual([
      { title: "Многоборье · КМС", rows: [[1, "Ф1 Анна", "Клуб", 52], [2, "Ф2 Анна", "Клуб", 51], [3, "Ф3 Анна", "Клуб", 50]] },
      { title: "Командное первенство · КМС", rows: [[1, "Область", "", 150.2]] },
    ]);
  });

  it("названия клубов сравниваются без кавычек, регистра и ё", () => {
    expect(run(`echo json_encode([ag_norm('СШОР «Спартак»') === ag_norm('сшор спартак'), ag_norm('Фёдорова  Ева'), ag_club_initial('СШОР «Спартак»'), ag_club_initial('ДЮСШ Дзержинск'), ag_score(13.45), ag_plural(21, 'день', 'дня', 'дней')]);`)).toEqual([
      true, "федорова ева", "С", "Д", "13,450", "день",
    ]);
  });
});
