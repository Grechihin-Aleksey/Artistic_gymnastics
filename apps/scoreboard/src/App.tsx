import { useEffect, useState } from "react";
import { Board } from "./Board";
import { isRelay, parseRoute, routeHash, type Route } from "./route";

interface Competition {
  id: string;
  name: string;
  discipline: string;
  /** Девочки и мальчики одного турнира (только в зале): обе части с одним pairId. */
  pairId?: string | null;
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
  useEffect(() => {
    const update = () => setRoute(parseRoute(location.hash));
    addEventListener("hashchange", update);
    return () => removeEventListener("hashchange", update);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = route.theme ?? "dark";
    if (route.embed) root.dataset.embed = "1";
    else delete root.dataset.embed;
  }, [route.theme, route.embed]);

  useEffect(() => {
    if (!route.embed || window.parent === window) return;
    // Странице сайта нужна высота виджета, чтобы подогнать под неё рамку.
    let sent = -1;
    const report = (force = false) => {
      // Высота содержимого, а не окна: иначе рамка могла бы только расти.
      const height = Math.ceil(Math.max(document.body.getBoundingClientRect().height, document.body.scrollHeight));
      if (height === 0 || (height === sent && !force)) return;
      sent = height;
      window.parent.postMessage({ type: "ag-results:height", height }, "*");
    };
    const observer = new ResizeObserver(() => report());
    observer.observe(document.body);
    // Safari на iPhone не всегда сообщает об изменении размера внутри рамки
    // (рамка оставалась высотой в шапку), поэтому ещё следим за содержимым и раз в секунду сверяемся.
    const mutations = new MutationObserver(() => report());
    mutations.observe(document.body, { childList: true, subtree: true, characterData: true });
    const timer = setInterval(report, 1000);
    const onMessage = (event: MessageEvent) => {
      if (event.source === window.parent && event.data?.type === "ag-results:measure") report(true);
    };
    window.addEventListener("message", onMessage);
    window.addEventListener("load", () => report(true));
    report();
    return () => {
      observer.disconnect();
      mutations.disconnect();
      clearInterval(timer);
      window.removeEventListener("message", onMessage);
    };
  }, [route.embed]);

  if (!route.competitionId) return <Picker />;
  return (
    <>
      {route.group && <GroupSwitch route={route} group={route.group} />}
      <Board key={route.competitionId} route={{ ...route, competitionId: route.competitionId }} />
    </>
  );
}

function useCompetitions(): Competition[] | null {
  const [list, setList] = useState<Competition[] | null>(null);
  useEffect(() => {
    // В зале список отдаёт сервер соревнований, на сайте — ретранслятор (уже свежие сверху).
    const relay = isRelay(location.pathname);
    fetch(relay ? "../api/competitions" : "/competitions")
      .then((r) => r.json() as Promise<Competition[]>)
      .then((items) => setList(relay ? items : [...items].reverse()))
      .catch(() => setList([]));
  }, []);
  return list;
}

/** Другое соревнование открывается с начала: разряд и клуб у него свои. */
function switchHash(route: Route, competitionId: string): string {
  const { category: _category, club: _club, ...rest } = route;
  return routeHash({ ...rest, competitionId, view: "auto" });
}

const GROUP_LABELS: Record<string, string> = { WAG: "Девочки", MAG: "Мальчики" };

/** Переключатель «Девочки | Мальчики», когда в одной рамке несколько соревнований. */
function GroupSwitch({ route, group }: { route: Route; group: string[] }) {
  const list = useCompetitions();
  const known = new Map(list?.map((c) => [c.id, c]));
  const disciplines = group.map((id) => known.get(id)?.discipline);
  // Подпись «Девочки» или «Мальчики», если у каждого соревнования своя программа, иначе название.
  const byDiscipline = new Set(disciplines).size === group.length;
  const label = (id: string, i: number) => {
    const c = known.get(id);
    if (!c) return `Соревнование ${i + 1}`;
    return (byDiscipline && GROUP_LABELS[c.discipline]) || c.name;
  };
  return (
    <nav className="group-switch" aria-label="Соревнования">
      {group.map((id, i) => (
        <a
          key={id}
          href={switchHash(route, id)}
          className={id === route.competitionId ? "active" : undefined}
          aria-current={id === route.competitionId ? "page" : undefined}
        >
          {label(id, i)}
        </a>
      ))}
    </nav>
  );
}

/** Без соревнования в адресе табло предлагает выбрать его из списка. */
function Picker() {
  const list = useCompetitions();
  return (
    <div className="center column">
      <h1>Выберите соревнование</h1>
      {list === null && <p className="muted">Загрузка…</p>}
      {list?.length === 0 && <p className="muted">Соревнований пока нет</p>}
      <ul className="picker">
        {list && pairUp(list).map(([c, other]) => (
          <li key={c.id}>
            <a href={routeHash(other ? { competitionId: c.id, group: [c.id, other.id], view: "auto" } : { competitionId: c.id, view: "auto" })}>
              {c.name} <span className="muted">{other ? "девочки и мальчики" : c.discipline}</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Турнир девочек и мальчиков — одна строка списка: девочки, затем мальчики. */
function pairUp(list: Competition[]): [Competition, Competition | undefined][] {
  const out: [Competition, Competition | undefined][] = [];
  const seen = new Set<string>();
  for (const c of list) {
    if (seen.has(c.id)) continue;
    const other = c.pairId ? list.find((o) => o.pairId === c.pairId && o.id !== c.id) : undefined;
    seen.add(c.id);
    if (other) seen.add(other.id);
    out.push(other && other.discipline === "WAG" ? [other, c] : [c, other]);
  }
  return out;
}
