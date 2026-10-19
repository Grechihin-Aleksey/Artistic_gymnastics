export type View = "auto" | "now" | "aa" | "teams" | string;

export interface Route {
  competitionId: string | null;
  view: View;
  /** Номер разряда в снимке (с нуля) для таблиц; в авторежиме показываются все. */
  category?: number;
  /** Табло встроено в страницу сайта. */
  embed?: boolean;
  theme?: "light" | "dark";
}

/** Адрес табло: #c=<id соревнования>&view=auto|now|aa|teams|BB…[&cat=1][&embed=1&theme=light] */
export function parseRoute(hash: string): Route {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const route: Route = { competitionId: params.get("c"), view: params.get("view") ?? "auto" };
  const category = Number(params.get("cat"));
  if (Number.isInteger(category) && category > 0) route.category = category;
  if (params.get("embed") === "1") route.embed = true;
  const theme = params.get("theme");
  if (theme === "light" || theme === "dark") route.theme = theme;
  return route;
}

export function routeHash(route: Route): string {
  const params = new URLSearchParams();
  if (route.competitionId) params.set("c", route.competitionId);
  if (route.view !== "auto") params.set("view", route.view);
  if (route.category) params.set("cat", String(route.category));
  if (route.embed) params.set("embed", "1");
  if (route.theme) params.set("theme", route.theme);
  return `#${params.toString()}`;
}

/**
 * Одна сборка работает в двух местах. В зале её раздаёт сервер соревнований
 * по адресу /board/, на сайте — облачный ретранслятор по адресу /widget/.
 */
export function isRelay(pathname: string): boolean {
  return /\/widget\/(index\.html)?$/.test(pathname);
}
