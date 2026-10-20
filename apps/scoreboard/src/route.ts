export type View = "auto" | "now" | "aa" | "teams" | string;

export interface Route {
  competitionId: string | null;
  view: View;
  /** Номер разряда в снимке (с нуля) для таблиц; в авторежиме показываются все. */
  category?: number;
  /** Табло встроено в страницу сайта. */
  embed?: boolean;
  theme?: "light" | "dark";
  /** Вид club: клуб, участников которого показать. */
  club?: string | undefined;
  /** Несколько соревнований в одной рамке (девочки и мальчики): переключатель над табло. */
  group?: string[];
}

/**
 * Адрес табло: #c=<id соревнования>&view=auto|now|aa|teams|docs|club|BB…[&cat=1][&club=Олимп][&embed=1&theme=light].
 * В c можно перечислить несколько соревнований через запятую, i — номер показанного (с нуля).
 */
export function parseRoute(hash: string): Route {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const ids = (params.get("c") ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  const route: Route = { competitionId: ids[0] ?? null, view: params.get("view") ?? "auto" };
  if (ids.length > 1) {
    route.group = ids;
    route.competitionId = ids[Number(params.get("i"))] ?? ids[0]!;
  }
  const category = Number(params.get("cat"));
  if (Number.isInteger(category) && category > 0) route.category = category;
  if (params.get("embed") === "1") route.embed = true;
  const theme = params.get("theme");
  if (theme === "light" || theme === "dark") route.theme = theme;
  const club = params.get("club")?.trim();
  if (club) route.club = club;
  return route;
}

export function routeHash(route: Route): string {
  const params = new URLSearchParams();
  if (route.group) {
    params.set("c", route.group.join(","));
    const index = route.competitionId ? route.group.indexOf(route.competitionId) : -1;
    if (index > 0) params.set("i", String(index));
  } else if (route.competitionId) params.set("c", route.competitionId);
  if (route.view !== "auto") params.set("view", route.view);
  if (route.category) params.set("cat", String(route.category));
  if (route.embed) params.set("embed", "1");
  if (route.theme) params.set("theme", route.theme);
  if (route.club) params.set("club", route.club);
  return `#${params.toString()}`;
}

/**
 * Одна сборка работает в двух местах. В зале её раздаёт сервер соревнований
 * по адресу /board/, на сайте — облачный ретранслятор по адресу /widget/.
 */
export function isRelay(pathname: string): boolean {
  return /\/widget\/(index\.html)?$/.test(pathname);
}
