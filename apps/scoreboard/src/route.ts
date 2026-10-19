export type View = "auto" | "now" | "aa" | "teams" | string;

export interface Route {
  competitionId: string | null;
  view: View;
}

/** Адрес табло: /board/#c=<id соревнования>&view=auto|now|aa|teams|BB… */
export function parseRoute(hash: string): Route {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  return { competitionId: params.get("c"), view: params.get("view") ?? "auto" };
}

export function routeHash(route: Route): string {
  const params = new URLSearchParams();
  if (route.competitionId) params.set("c", route.competitionId);
  if (route.view !== "auto") params.set("view", route.view);
  return `#${params.toString()}`;
}
