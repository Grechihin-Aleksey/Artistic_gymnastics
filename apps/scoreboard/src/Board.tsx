import { useCallback, useEffect, useMemo, useState } from "react";
import {
  APPARATUS_NAMES,
  type AllAroundRow,
  type ApparatusResultRow,
  type GymnastView,
  type LiveApparatus,
  type PerformanceView,
  type TeamResultRow,
} from "@ag/shared";
import { routeHash, type Route } from "./route";
import { buildSlides, pageRows, type Slide, type SlideKind } from "./slides";
import { useBoard, type BoardData } from "./useBoard";

const SHORT: Record<string, string> = {
  FX: "Вольные",
  PH: "Конь",
  SR: "Кольца",
  VT: "Прыжок",
  PB: "Брусья",
  HB: "Перекл.",
  UB: "Брусья",
  BB: "Бревно",
};

const SLIDE_SECONDS = 12;

const fmt = (n: number) => n.toFixed(3);
const fullName = (g: GymnastView) => `${g.lastName} ${g.firstName}`;

interface Flash {
  key: string;
  apparatus: string;
  gymnast: GymnastView | undefined;
  total: number;
}

export function Board({ route }: { route: Route & { competitionId: string } }) {
  const [flash, setFlash] = useState<Flash | null>(null);
  const [gymnasts, setGymnasts] = useState<Map<string, GymnastView>>(new Map());

  const onApproved = useCallback(
    (p: PerformanceView) => {
      if (!p.score) return;
      setFlash({
        key: p.id,
        apparatus: p.apparatus,
        gymnast: gymnasts.get(p.gymnastId),
        total: p.score.total,
      });
    },
    [gymnasts],
  );
  const { data, connected, error } = useBoard(route.competitionId, onApproved);

  useEffect(() => {
    if (!data) return;
    const people = new Map<string, GymnastView>();
    for (const row of data.allAround) people.set(row.gymnast.id, row.gymnast);
    for (const a of data.live)
      if (a.current) people.set(a.current.gymnast.id, a.current.gymnast);
    setGymnasts(people);
  }, [data]);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 8000);
    return () => clearTimeout(t);
  }, [flash]);

  const slides = useMemo(
    () =>
      data
        ? buildSlides({
            aa: data.allAround.length,
            teams: data.teams.length,
            apparatus: data.live.map((a) => ({
              code: a.apparatus,
              rows: data.apparatus[a.apparatus]?.length ?? 0,
            })),
          })
        : [],
    [data],
  );
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (route.view !== "auto" || slides.length < 2) return;
    const t = setInterval(
      () => setIndex((i) => (i + 1) % slides.length),
      SLIDE_SECONDS * 1000,
    );
    return () => clearInterval(t);
  }, [route.view, slides.length]);

  if (!data) {
    return (
      <div className="center">
        {error ? `Нет связи с сервером: ${error}` : "Загрузка…"}
      </div>
    );
  }

  const slide: Slide =
    route.view === "auto"
      ? (slides[index % slides.length] ?? { kind: "now", page: 0, pages: 1 })
      : { kind: kindFromView(route.view), page: 0, pages: 1 };

  return (
    <div className="board">
      <header className="top">
        <div className="title">{data.competition.name}</div>
        <nav>
          {[
            ["auto", "Авто"],
            ["now", "Сейчас"],
            ["aa", "Многоборье"],
            ...(data.teams.length > 0 ? [["teams", "Команды"]] : []),
            ...data.live.map((a) => [
              a.apparatus,
              SHORT[a.apparatus] ?? a.apparatus,
            ]),
          ].map(([view, label]) => (
            <a
              key={view}
              href={routeHash({
                competitionId: route.competitionId,
                view: view!,
              })}
              className={route.view === view ? "active" : ""}
            >
              {label}
            </a>
          ))}
        </nav>
        <span
          className={connected ? "dot ok" : "dot down"}
          title={connected ? "На связи" : "Нет связи"}
        />
      </header>

      {flash && (
        <div className="flash" key={flash.key}>
          <span className="flash-app">{APPARATUS_NAMES[flash.apparatus]}</span>
          <span className="flash-name">
            {flash.gymnast
              ? `№${flash.gymnast.bib} ${fullName(flash.gymnast)}`
              : "Новая оценка"}
          </span>
          <span className="flash-score">{fmt(flash.total)}</span>
        </div>
      )}

      <main className="content">
        <SlideView data={data} slide={slide} />
      </main>
    </div>
  );
}

function kindFromView(view: string): SlideKind {
  if (view === "now" || view === "aa" || view === "teams") return view;
  return { apparatus: view };
}

function SlideView({ data, slide }: { data: BoardData; slide: Slide }) {
  const pageNote = slide.pages > 1 ? ` · ${slide.page + 1}/${slide.pages}` : "";
  if (slide.kind === "now") return <NowView live={data.live} />;
  if (slide.kind === "aa") {
    return (
      <AllAroundTable
        rows={
          slide.pages > 1
            ? pageRows(data.allAround, slide.page)
            : data.allAround
        }
        apparatus={data.live.map((a) => a.apparatus)}
        note={pageNote}
      />
    );
  }
  if (slide.kind === "teams") {
    return (
      <TeamsTable
        rows={slide.pages > 1 ? pageRows(data.teams, slide.page) : data.teams}
        note={pageNote}
      />
    );
  }
  const code = slide.kind.apparatus;
  const rows = data.apparatus[code] ?? [];
  return (
    <ApparatusTable
      code={code}
      rows={slide.pages > 1 ? pageRows(rows, slide.page) : rows}
      note={pageNote}
    />
  );
}

function NowView({ live }: { live: LiveApparatus[] }) {
  return (
    <section>
      <h1>Сейчас на снарядах</h1>
      <div className="now-grid">
        {live.map((a) => (
          <article key={a.apparatus} className="now-card">
            <h2>{APPARATUS_NAMES[a.apparatus]}</h2>
            <div className="label">Выступает</div>
            {a.current ? (
              <div className="performer">
                <span className="bib">№{a.current.gymnast.bib}</span>{" "}
                {fullName(a.current.gymnast)}
                {a.apparatus === "VT" && (
                  <span className="muted"> · прыжок {a.current.attempt}</span>
                )}
                {a.current.gymnast.club && (
                  <div className="muted">{a.current.gymnast.club}</div>
                )}
              </div>
            ) : (
              <div className="muted performer">—</div>
            )}
            <div className="label">Последняя оценка</div>
            {a.last ? (
              <div className="last">
                <div>
                  <span className="bib">№{a.last.gymnast.bib}</span>{" "}
                  {fullName(a.last.gymnast)}
                </div>
                <div className="score">{fmt(a.last.score.total)}</div>
                <div className="parts">
                  D {fmt(a.last.score.d)} · E {fmt(a.last.score.e)}
                  {a.last.score.neutral > 0 &&
                    ` · −${fmt(a.last.score.neutral)}`}
                </div>
                {a.last.eMarks && (
                  <div className="parts muted">
                    E: {a.last.eMarks.map(fmt).join(" · ")}
                  </div>
                )}
              </div>
            ) : (
              <div className="muted">—</div>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

function Empty() {
  return <p className="muted center-text">Оценок пока нет</p>;
}

function ApparatusTable({
  code,
  rows,
  note,
}: {
  code: string;
  rows: ApparatusResultRow[];
  note: string;
}) {
  return (
    <section>
      <h1>
        {APPARATUS_NAMES[code]}
        {note}
      </h1>
      {rows.length === 0 ? (
        <Empty />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Место</th>
                <th>№</th>
                <th className="name-col">Участник</th>
                <th className="num">D</th>
                <th className="num">E</th>
                <th className="num">Сбавки</th>
                <th className="num">Итог</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.gymnast.id}>
                  <td className="rank">{r.rank}</td>
                  <td>{r.gymnast.bib}</td>
                  <td className="name-col">
                    {fullName(r.gymnast)}{" "}
                    <span className="muted">{r.gymnast.club}</span>
                  </td>
                  <td className="num">{fmt(r.score.d)}</td>
                  <td className="num">{fmt(r.score.e)}</td>
                  <td className="num">
                    {r.score.neutral > 0 ? `−${fmt(r.score.neutral)}` : ""}
                  </td>
                  <td className="num total">{fmt(r.score.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function AllAroundTable({
  rows,
  apparatus,
  note,
}: {
  rows: AllAroundRow[];
  apparatus: string[];
  note: string;
}) {
  return (
    <section>
      <h1>Многоборье{note}</h1>
      {rows.length === 0 ? (
        <Empty />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Место</th>
                <th>№</th>
                <th className="name-col">Участник</th>
                {apparatus.map((a) => (
                  <th key={a} className="num">
                    {SHORT[a]}
                  </th>
                ))}
                <th className="num">Сумма</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.gymnast.id}>
                  <td className="rank">{r.rank}</td>
                  <td>{r.gymnast.bib}</td>
                  <td className="name-col">
                    {fullName(r.gymnast)}{" "}
                    <span className="muted">{r.gymnast.club}</span>
                  </td>
                  {apparatus.map((a) => {
                    const s = r.apparatus[a as keyof typeof r.apparatus];
                    return (
                      <td key={a} className="num">
                        {s ? fmt(s.total) : ""}
                      </td>
                    );
                  })}
                  <td className="num total">{fmt(r.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function TeamsTable({ rows, note }: { rows: TeamResultRow[]; note: string }) {
  const apparatus = rows[0]?.apparatus.map((a) => a.apparatus) ?? [];
  return (
    <section>
      <h1>Командный зачёт{note}</h1>
      {rows.length === 0 ? (
        <Empty />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Место</th>
                <th className="name-col">Команда</th>
                {apparatus.map((a) => (
                  <th key={a} className="num">
                    {SHORT[a]}
                  </th>
                ))}
                <th className="num">Сумма</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.team.id}>
                  <td className="rank">{r.rank}</td>
                  <td className="name-col">{r.team.name}</td>
                  {r.apparatus.map((a) => (
                    <td key={a.apparatus} className="num">
                      {a.counted.length > 0 ? fmt(a.total) : ""}
                    </td>
                  ))}
                  <td className="num total">{fmt(r.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
