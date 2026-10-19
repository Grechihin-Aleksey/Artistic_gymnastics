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
  return <Board key={route.competitionId} route={{ ...route, competitionId: route.competitionId }} />;
}

/** Без соревнования в адресе табло предлагает выбрать его из списка. */
function Picker() {
  const [list, setList] = useState<Competition[] | null>(null);
  useEffect(() => {
    // В зале список отдаёт сервер соревнований, на сайте — ретранслятор (уже свежие сверху).
    const relay = isRelay(location.pathname);
    fetch(relay ? "../api/competitions" : "/competitions")
      .then((r) => r.json() as Promise<Competition[]>)
      .then((items) => setList(relay ? items : [...items].reverse()))
      .catch(() => setList([]));
  }, []);
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
