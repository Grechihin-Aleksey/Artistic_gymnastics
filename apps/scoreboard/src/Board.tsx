import { useCallback, useEffect, useMemo, useState } from "react";
import {
  APPARATUS_NAMES,
  scoreLabels,
  type AllAroundRow,
  type ApparatusResultRow,
  type CeremonyView,
  type GymnastView,
  type LiveApparatus,
  type PerformanceView,
  type ProtocolsIndex,
  type Rules,
  type TeamResultRow,
} from "@ag/shared";
import { ApparatusIcon } from "./ApparatusIcon";
import { clubList, clubResults } from "./club";
import { isRelay, routeHash, type Route } from "./route";
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
  gymnastId: string;
  total: number;
}

export function Board({ route }: { route: Route & { competitionId: string } }) {
  const [flash, setFlash] = useState<Flash | null>(null);

  const onApproved = useCallback((p: PerformanceView) => {
    if (!p.score) return;
    setFlash({ key: p.id, apparatus: p.apparatus, gymnastId: p.gymnastId, total: p.score.total });
  }, []);
  const { data, connected, error } = useBoard(route.competitionId, onApproved);
  const protocols = useProtocols(route.competitionId);

  // Имя ищем при показе, а не при получении оценки: свежий снимок мог прийти чуть позже неё.
  const gymnasts = useMemo(() => {
    const people = new Map<string, GymnastView>();
    if (!data) return people;
    for (const c of data.categories) for (const row of c.allAround) people.set(row.gymnast.id, row.gymnast);
    for (const a of data.live) if (a.current) people.set(a.current.gymnast.id, a.current.gymnast);
    return people;
  }, [data]);
  const flashGymnast = flash ? gymnasts.get(flash.gymnastId) : undefined;

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 8000);
    return () => clearTimeout(t);
  }, [flash]);

  const slides = useMemo(
    () =>
      data
        ? buildSlides(
            data.categories.map((c) => ({
              aa: c.allAround.length,
              teams: c.teams.length,
              apparatus: data.live.map((a) => ({
                code: a.apparatus,
                rows: c.apparatus[a.apparatus]?.length ?? 0,
              })),
            })),
          )
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

  if (!data) return <Waiting message={error} />;

  const selected = Math.min(route.category ?? 0, data.categories.length - 1);
  const slide: Slide =
    route.view === "auto"
      ? (slides[index % slides.length] ?? { kind: "now", category: 0, page: 0, pages: 1 })
      : { kind: kindFromView(route.view), category: selected, page: 0, pages: 1 };
  const categories = data.categories.length > 1 ? data.categories : [];

  return (
    <div className="board">
      <header className="top">
        <div className="title">{data.competition.name}</div>
        <nav>
          {[
            ["auto", "Авто"],
            ["now", "Сейчас"],
            ["aa", "Многоборье"],
            ...(data.categories[selected]!.teams.length > 0 ? [["teams", "Команды"]] : []),
            ...data.live.map((a) => [
              a.apparatus,
              SHORT[a.apparatus] ?? a.apparatus,
            ]),
            ["club", "Мой клуб"],
            ...(protocols && protocols.files.length > 0 ? [["docs", "Протоколы"]] : []),
          ].map(([view, label]) => (
            <a
              key={view}
              href={routeHash(view === "club" ? { ...route, view: view! } : { ...route, view: view!, club: undefined })}
              className={route.view === view ? "active" : ""}
            >
              <ApparatusIcon code={view!} />
              {label}
            </a>
          ))}
        </nav>
        <span
          className={connected ? "dot ok" : "dot down"}
          title={connected ? "На связи" : "Нет связи"}
        />
      </header>
      {categories.length > 0 && route.view !== "auto" && route.view !== "now" && route.view !== "docs" && route.view !== "club" && (
        <nav className="categories">
          {categories.map((c, i) => (
            <a
              key={c.id ?? "none"}
              href={routeHash({ ...route, category: i })}
              className={i === selected ? "active" : ""}
            >
              {c.name}
            </a>
          ))}
        </nav>
      )}

      {flash && (
        <div className="flash" key={flash.key}>
          <span className="flash-app">
            <ApparatusIcon code={flash.apparatus} />
            {APPARATUS_NAMES[flash.apparatus]}
          </span>
          <span className="flash-name">
            {flashGymnast
              ? `№${flashGymnast.bib} ${fullName(flashGymnast)}`
              : "Новая оценка"}
          </span>
          <span className="flash-score">{fmt(flash.total)}</span>
        </div>
      )}

      <main className="content">
        {route.view === "club" ? (
          <ClubView data={data} route={route} />
        ) : route.view === "docs" ? (
          <ProtocolsList competitionId={route.competitionId} index={protocols} />
        ) : data.ceremony && route.view === "auto" ? (
          <Podium ceremony={data.ceremony} />
        ) : (
          <SlideView data={data} slide={slide} />
        )}
      </main>
    </div>
  );
}

/**
 * Мой клуб: тренер открывает ссылку с телефона и видит своих участников —
 * места в многоборье и на снарядах, кто выступает прямо сейчас.
 */
function ClubView({ data, route }: { data: BoardData; route: Route & { competitionId: string } }) {
  if (!route.club) {
    const clubs = clubList(data);
    return (
      <section>
        <h1>Выберите клуб</h1>
        {clubs.length === 0 ? (
          <Empty />
        ) : (
          <ul className="club-list">
            {clubs.map((c) => (
              <li key={c}>
                <a href={routeHash({ ...route, club: c })}>{c}</a>
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }
  const people = clubResults(data, route.club);
  const final = data.competition.phase === "FINAL";
  return (
    <section className="club">
      <h1>{route.club}</h1>
      <p className="muted">
        <a href={routeHash({ ...route, club: undefined })}>Другой клуб</a> · места обновляются сами
        {final && " · на снарядах — места в финале"}
      </p>
      {people.length === 0 ? (
        <p className="muted center-text">У участников клуба пока нет оценок</p>
      ) : (
        <div className="club-grid">
          {people.map((p) => (
            <article key={p.gymnast.id} className="club-card">
              <header>
                <span className="bib">№{p.gymnast.bib}</span> <strong>{fullName(p.gymnast)}</strong>
                {p.category && <span className="muted"> · {p.category}</span>}
              </header>
              {p.now && (
                <div className="now-badge">
                  Выступает: <ApparatusIcon code={p.now} />
                  {APPARATUS_NAMES[p.now]}
                </div>
              )}
              {p.allAround && (
                <div className="club-aa">
                  Многоборье: <strong>{p.allAround.complete ? `${p.allAround.rank} место` : "идёт"}</strong>
                  <span className="club-aa-total"> {fmt(p.allAround.total)}</span>
                </div>
              )}
              {p.apparatus.length > 0 && (
                <table>
                  <tbody>
                    {p.apparatus.map((a) => (
                      <tr key={a.apparatus}>
                        <td>
                          <ApparatusIcon code={a.apparatus} />
                          {APPARATUS_NAMES[a.apparatus]}
                        </td>
                        <td className="num">{a.rank} место</td>
                        <td className="num total">{fmt(a.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

const protocolsUrl = (competitionId: string, file?: string) =>
  `../api/competitions/${encodeURIComponent(competitionId)}/protocols${file ? `/${encodeURIComponent(file)}` : ""}`;

/** Протоколы, выложенные залом на сайт; в зале их нет (null) — печатает секретариат. */
function useProtocols(competitionId: string): ProtocolsIndex | null {
  const [index, setIndex] = useState<ProtocolsIndex | null>(null);
  useEffect(() => {
    if (!isRelay(location.pathname)) return;
    const load = () =>
      fetch(protocolsUrl(competitionId))
        .then((r) => (r.ok ? (r.json() as Promise<ProtocolsIndex>) : null))
        .then(setIndex)
        .catch(() => undefined);
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [competitionId]);
  return index;
}

const fileSize = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} КБ` : `${(bytes / 1024 / 1024).toFixed(1)} МБ`);

export function ProtocolsList({ competitionId, index }: { competitionId: string; index: ProtocolsIndex | null }) {
  if (!index || index.files.length === 0) {
    return (
      <section>
        <h1>Протоколы</h1>
        <p className="muted center-text">Протоколы появятся здесь, когда секретариат их опубликует</p>
      </section>
    );
  }
  const groups = [...new Set(index.files.map((f) => f.group))];
  return (
    <section className="protocols">
      <h1>Протоколы</h1>
      <p className="muted">
        Опубликованы {new Date(index.publishedAt).toLocaleString("ru-RU", { dateStyle: "long", timeStyle: "short" })}
      </p>
      {groups.map((group) => (
        <div key={group || "common"} className="protocol-group">
          <h2>{group || "Общие"}</h2>
          <ul>
            {index.files
              .filter((f) => f.group === group)
              .map((f) => (
                <li key={f.file}>
                  <a href={protocolsUrl(competitionId, f.file)} target="_blank" rel="noopener">
                    {f.title}
                  </a>{" "}
                  <span className="muted">
                    {f.file.endsWith(".xlsx") ? "Excel" : "PDF"}, {fileSize(f.size)}
                  </span>
                </li>
              ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

/** Награждение: пьедестал 2–1–3, при равенстве на одной ступени несколько призёров. */
export function Podium({ ceremony }: { ceremony: CeremonyView }) {
  const steps = [2, 1, 3]
    .map((place) => ({ place, winners: ceremony.podium.filter((p) => p.place === place) }))
    .filter((s) => s.winners.length > 0);
  return (
    <section className="ceremony">
      <div className="ceremony-label">Награждение</div>
      <h1>{ceremony.title}</h1>
      {steps.length === 0 ? (
        <Empty />
      ) : (
        <div className="podium">
          {steps.map((s) => (
            <div key={s.place} className={`step place-${s.place}`}>
              <div className="winners">
                {s.winners.map((w) => (
                  <div key={w.name} className="winner">
                    <div className="winner-name">{w.name}</div>
                    {w.detail && <div className="muted">{w.detail}</div>}
                    <div className="winner-total">{ceremony.points ? `${w.total} очк.` : fmt(w.total)}</div>
                  </div>
                ))}
              </div>
              <div className="block">{s.place}</div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function kindFromView(view: string): SlideKind {
  if (view === "now" || view === "aa" || view === "teams") return view;
  return { apparatus: view };
}

function SlideView({ data, slide }: { data: BoardData; slide: Slide }) {
  const rules = data.competition.rules;
  if (slide.kind === "now") return <NowView live={data.live} categories={data.categories} rules={rules} />;
  const category = data.categories[slide.category] ?? data.categories[0]!;
  const pageNote =
    (category.name ? ` · ${category.name}` : "") + (slide.pages > 1 ? ` · ${slide.page + 1}/${slide.pages}` : "");
  if (slide.kind === "aa") {
    return (
      <AllAroundTable
        rows={
          slide.pages > 1
            ? pageRows(category.allAround, slide.page)
            : category.allAround
        }
        apparatus={data.live.map((a) => a.apparatus)}
        note={pageNote}
      />
    );
  }
  if (slide.kind === "teams") {
    return (
      <TeamsTable
        rows={slide.pages > 1 ? pageRows(category.teams, slide.page) : category.teams}
        note={pageNote}
      />
    );
  }
  const code = slide.kind.apparatus;
  const rows = category.apparatus[code as LiveApparatus["apparatus"]] ?? [];
  return (
    <ApparatusTable
      code={code}
      rules={rules}
      final={data.competition.phase === "FINAL"}
      rows={slide.pages > 1 ? pageRows(rows, slide.page) : rows}
      note={pageNote}
    />
  );
}

function NowView({
  live,
  categories,
  rules,
}: {
  live: LiveApparatus[];
  categories: BoardData["categories"];
  rules: Rules | undefined;
}) {
  const labels = scoreLabels(rules);
  const categoryName = (g: GymnastView) =>
    categories.length > 1 ? categories.find((c) => c.id === g.categoryId)?.name : undefined;
  return (
    <section>
      <h1>Сейчас на снарядах</h1>
      <div className="now-grid">
        {live.map((a) => (
          <article key={a.apparatus} className="now-card">
            <h2>
              <ApparatusIcon code={a.apparatus} />
              {APPARATUS_NAMES[a.apparatus]}
            </h2>
            <div className="label">Выступает</div>
            {a.current ? (
              <div className="performer">
                <span className="bib">№{a.current.gymnast.bib}</span>{" "}
                {fullName(a.current.gymnast)}
                {a.apparatus === "VT" && (
                  <span className="muted"> · прыжок {a.current.attempt}</span>
                )}
                {(a.current.gymnast.club || categoryName(a.current.gymnast)) && (
                  <div className="muted">
                    {[categoryName(a.current.gymnast), a.current.gymnast.club].filter(Boolean).join(" · ")}
                  </div>
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
                  {labels.d} {fmt(a.last.score.d)} · {labels.e} {fmt(Math.abs(a.last.score.e))}
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
  rules,
  final,
  rows,
  note,
}: {
  code: string;
  rules: Rules | undefined;
  /** Идут финалы: в таблице финальные оценки. */
  final: boolean;
  rows: ApparatusResultRow[];
  note: string;
}) {
  const labels = scoreLabels(rules);
  return (
    <section>
      <h1>
        <ApparatusIcon code={code} />
        {final && "Финал: "}
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
                <th className="bib">№</th>
                <th className="name-col">Участник</th>
                <th className="num">{labels.d}</th>
                <th className="num">{labels.e}</th>
                <th className="num pen">{rules === "CUSTOM" ? "НС" : "Сбавки"}</th>
                <th className="num">Итог</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.gymnast.id}>
                  <td className="rank">{r.rank}</td>
                  <td className="bib">{r.gymnast.bib}</td>
                  <td className="name-col">
                    <span className="bib-inline muted">№{r.gymnast.bib} </span>
                    {fullName(r.gymnast)}{" "}
                    <span className="muted">{r.gymnast.club}</span>
                  </td>
                  <td className="num">{fmt(r.score.d)}</td>
                  <td className="num">{fmt(Math.abs(r.score.e))}</td>
                  <td className="num pen">
                    {r.score.neutral > 0 ? `−${fmt(r.score.neutral)}` : ""}
                  </td>
                  <td className="num total">
                    {fmt(r.score.total)}
                    {r.score.neutral > 0 && <span className="pen-inline muted">−{fmt(r.score.neutral)}</span>}
                  </td>
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
                <th className="bib">№</th>
                <th className="name-col">Участник</th>
                {apparatus.map((a) => (
                  <th key={a} className="num ap">
                    <ApparatusIcon code={a} />
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
                  <td className="bib">{r.gymnast.bib}</td>
                  <td className="name-col">
                    <span className="bib-inline muted">№{r.gymnast.bib} </span>
                    {fullName(r.gymnast)}{" "}
                    <span className="muted">{r.gymnast.club}</span>
                    <ApparatusLine
                      scores={apparatus.map((a) => [a, r.apparatus[a as keyof typeof r.apparatus]?.total])}
                    />
                  </td>
                  {apparatus.map((a) => {
                    const s = r.apparatus[a as keyof typeof r.apparatus];
                    return (
                      <td key={a} className="num ap">
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
                  <th key={a} className="num ap">
                    <ApparatusIcon code={a} />
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
                  <td className="name-col">
                    {r.team.name}
                    <ApparatusLine
                      scores={r.apparatus.map((a) => [a.apparatus, a.counted.length > 0 ? a.total : undefined])}
                    />
                  </td>
                  {r.apparatus.map((a) => (
                    <td key={a.apparatus} className="num ap">
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

/** Оценки по снарядам строкой под именем: на телефоне вместо отдельных столбцов. */
function ApparatusLine({ scores }: { scores: [string, number | undefined][] }) {
  return (
    <span className="ap-line">
      {scores.map(([code, total]) => (
        <span key={code}>
          <ApparatusIcon code={code} />
          {total === undefined ? "—" : fmt(total)}
        </span>
      ))}
    </span>
  );
}

/** Заставка, пока зал не прислал результаты: значки снарядов и одна строка о том, чего ждём. */
function Waiting({ message }: { message: string | null }) {
  return (
    <div className="center column waiting">
      <div className="waiting-icons" aria-hidden="true">
        {["VT", "UB", "BB", "FX"].map((code) => (
          <ApparatusIcon key={code} code={code} />
        ))}
      </div>
      <div className="waiting-title">Результаты соревнований</div>
      <div className="waiting-text">{message ?? "Подключаемся к табло…"}</div>
    </div>
  );
}
