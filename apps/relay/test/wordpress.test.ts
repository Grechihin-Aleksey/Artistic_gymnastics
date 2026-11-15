import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const hasPhp = spawnSync("php", ["-v"]).status === 0;
const PLUGIN = join(__dirname, "..", "wordpress", "ag-results", "ag-results.php");
const ID = "0b9b6a52-6c1e-4f0e-9a4f-2f1d3c4b5a69";
const ID2 = "1c9b6a52-6c1e-4f0e-9a4f-2f1d3c4b5a69";

/** Плагин в минимальной обвязке WordPress: шорткод с атрибутами → HTML и подключённые скрипты. */
function render(atts: Record<string, string>, opts: { base?: string; editor?: boolean; tag?: string } = {}) {
  const code = `
    define('ABSPATH', '/');
    $GLOBALS['shortcodes'] = []; $GLOBALS['scripts'] = []; $GLOBALS['filters'] = [];
    function add_shortcode($t, $f) { $GLOBALS['shortcodes'][$t] = $f; }
    function add_filter($t, $f) { $GLOBALS['filters'][$t] = $f; }
    function add_action($t, $f) {}
    function get_option($k, $d = false) { return ${JSON.stringify(opts.base ?? "")}; }
    function home_url($p = '') { return 'https://ffk52.ru' . $p; }
    function shortcode_atts($pairs, $atts) { $out = []; foreach ($pairs as $k => $v) $out[$k] = array_key_exists($k, (array) $atts) ? $atts[$k] : $v; return $out; }
    function current_user_can($c) { return ${opts.editor ? "true" : "false"}; }
    function esc_attr($s) { return htmlspecialchars((string) $s, ENT_QUOTES); }
    function esc_html($s) { return htmlspecialchars((string) $s, ENT_QUOTES); }
    function esc_url($s) { return str_replace('&', '&#038;', (string) $s); }
    function wp_strip_all_tags($s) { return strip_tags((string) $s); }
    function wp_enqueue_script($h, $src) { $GLOBALS['scripts'][$h] = $src; }
    require ${JSON.stringify(PLUGIN)};
    $html = call_user_func($GLOBALS['shortcodes'][${JSON.stringify(opts.tag ?? "ag_results")}], json_decode($argv[1], true));
    $tag = call_user_func($GLOBALS['filters']['script_loader_tag'], "<script src='x'></script>", 'ag-results-embed');
    echo json_encode(['html' => $html, 'scripts' => $GLOBALS['scripts'], 'tag' => $tag]);
  `;
  const out = spawnSync("php", ["-r", code, JSON.stringify(atts)], { encoding: "utf8" });
  if (out.status !== 0) throw new Error(out.stderr || out.stdout);
  return JSON.parse(out.stdout) as { html: string; scripts: Record<string, string>; tag: string };
}

describe.skipIf(!hasPhp)("плагин WordPress: шорткод табло", () => {
  it("вставляет рамку табло и скрипт с ретранслятора этого сайта", () => {
    const r = render({ id: ID, theme: "dark", category: "2" });
    expect(r.html).toBe(`<div data-ag-results="${ID}" data-view="auto" data-theme="dark" data-category="2"></div>`);
    expect(r.scripts).toEqual({ "ag-results-embed": "https://ffk52.ru/results/embed.js" });
    expect(r.tag).toBe("<script async src='x'></script>");
  });

  it("две части турнира и свой адрес ретранслятора", () => {
    const r = render({ id: `${ID}, ${ID2}`, view: "BB" }, { base: "https://relay.example.ru/r/" });
    expect(r.html).toBe(`<div data-ag-results="${ID},${ID2}" data-view="BB" data-theme="light"></div>`);
    expect(r.scripts["ag-results-embed"]).toBe("https://relay.example.ru/r/embed.js");
  });

  it("лишнее в атрибутах не попадает на страницу", () => {
    const r = render({ id: ID, view: '"><script>alert(1)</script>', theme: "red", category: "x" });
    expect(r.html).toBe(`<div data-ag-results="${ID}" data-view="auto" data-theme="light"></div>`);
    expect(render({ id: `${ID}"><script>` }).html).toBe("");
    expect(render({ id: "" }, { editor: true }).html).toContain("нет ID соревнования");
    expect(Object.keys(render({ id: "" }).scripts)).toHaveLength(0);
  });
});

const KEY = "Qm9yb2RpbmEtMjAyNi1rZXktMDEyMzQ1Njc4";

describe.skipIf(!hasPhp)("плагин WordPress: кнопка «Подать заявку»", () => {
  const entry = (atts: Record<string, string>, opts: { base?: string; editor?: boolean } = {}) =>
    render(atts, { ...opts, tag: "ag_entry" }).html;

  it("ведёт на форму заявки ретранслятора этого сайта", () => {
    const html = entry({ id: ID, key: KEY });
    expect(html).toMatch(/^<style id="ag-entry-style">.*#0039A6.*#D52B1E.*<\/style>/);
    expect(html.replace(/^<style[^]*?<\/style>/, "")).toBe(
      `<div class="ag-entry"><a class="ag-entry__button" href="https://ffk52.ru/results/entry/index.html#c=${ID}&#038;k=${KEY}" target="_blank" rel="noopener"><span class="ag-entry__text">Подать заявку</span><span class="ag-entry__flag" aria-hidden="true"><span></span><span></span><span></span></span></a></div>`,
    );
    expect(entry({ id: ID, key: KEY, text: "Заявка на Кубок" }, { base: "https://relay.example.ru/r" })).toContain(
      `href="https://relay.example.ru/r/entry/index.html#c=${ID}&#038;k=${KEY}"`,
    );
    expect(entry({ id: ID, key: KEY, text: "Заявка на Кубок" })).toContain(">Заявка на Кубок</span>");
  });

  it("лишнее в атрибутах не попадает на страницу", () => {
    expect(entry({ id: ID, key: KEY, text: '<b onclick="x">Жми</b>' })).toContain('<span class="ag-entry__text">Жми</span>');
    expect(entry({ id: ID, key: `${KEY}"><script>` })).toBe("");
    expect(entry({ id: "x", key: KEY })).toBe("");
    expect(entry({ id: ID, key: "" }, { editor: true })).toContain("Скопируйте шорткод заново");
  });
});
