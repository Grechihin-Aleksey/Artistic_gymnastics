import { useEffect, useState } from "react";
import { Board } from "./Board";
import { parseRoute, routeHash, type Route } from "./route";

interface Competition {
  id: string;
  name: string;
  discipline: string;
  createdAt: string;
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
  useEffect(() => {
    const update = () => setRoute(parseRoute(location.hash));
    addEventListener("hashchange", update);
    return () => removeEventListener("hashchange", update);
  }, []);

  if (!route.competitionId) return <Picker />;
  return <Board key={route.competitionId} route={{ ...route, competitionId: route.competitionId }} />;
}

/** Без соревнования в адресе табло предлагает выбрать его из списка. */
function Picker() {
  const [list, setList] = useState<Competition[] | null>(null);
  useEffect(() => {
    fetch("/competitions")
      .then((r) => r.json() as Promise<Competition[]>)
      .then((items) => setList([...items].reverse()))
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
