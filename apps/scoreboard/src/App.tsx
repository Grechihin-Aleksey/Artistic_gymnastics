import { useEffect, useState } from "react";
import { Board } from "./Board";
import { isRelay, parseRoute, routeHash, type Route } from "./route";

interface Competition {
  id: string;
  name: string;
  discipline: string;
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
    const report = () =>
      window.parent.postMessage(
        // Высота содержимого, а не окна: иначе рамка могла бы только расти.
        { type: "ag-results:height", height: document.body.getBoundingClientRect().height },
        "*",
      );
    const observer = new ResizeObserver(report);
    observer.observe(document.body);
    report();
    return () => observer.disconnect();
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
        {list?.map((c) => (
          <li key={c.id}>
            <a href={routeHash({ competitionId: c.id, view: "auto" })}>
              {c.name} <span className="muted">{c.discipline}</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
