import { useEffect, useMemo, useState } from "react";
import {
  APPARATUS_NAMES,
  type BoardSnapshot,
  type FinalsView,
  type GymnastView,
  type RotationView,
} from "@ag/shared";
import { ApparatusIcon } from "./ApparatusIcon";
import { upcoming, type QueuePerson } from "./forecast";
import { useBoard } from "./useBoard";

const fmt = (n: number) => n.toFixed(3);

type Person = QueuePerson;

/** Сколько следующих участников показывать на каждом снаряде. */
const NEXT_COUNT = 2;

export interface AnnouncerApparatus {
  apparatus: string;
  current: (GymnastView & { attempt: number; category: string }) | null;
  last: {
    gymnast: GymnastView;
    category: string;
    attempt: number;
    total: number;
    d: number;
    e: number;
    neutral: number;
    /** Место на снаряде в разряде после этой оценки. */
    rank: number | null;
    /** Место и сумма в многоборье. */
    allAround: { rank: number; total: number } | null;
  } | null;
  next: (Person & { category: string })[];
  /** В этой ротации на снаряде нет смены. */
  idle: boolean;
}

/**
 * Всё, что нужно диктору по каждому снаряду: кто выступает, последняя оценка с местом
 * и кто выходит следующим. Следующие — по порядку смены в текущей ротации (в финале —
 * по составу финала), кроме уже получивших оценку на этом снаряде.
 */
export function announcerView(
  data: BoardSnapshot,
  rotation: RotationView | null,
  finals: FinalsView | null,
  people: Person[],
): AnnouncerApparatus[] {
  const categoryName = new Map(data.categories.map((c) => [c.id, c.name]));
  const catOf = (id: string | null | undefined) => (id ? (categoryName.get(id) ?? "") : "");
  const isFinal = data.competition.phase === "FINAL";
  const queues = upcoming(data, rotation, finals, people);

  return data.live.map((live) => {
    const app = live.apparatus;
    const { queue, idle } = queues.get(app)!;
    const next = queue.slice(0, NEXT_COUNT).map((p) => ({ ...p, category: catOf(p.categoryId) }));

    let last: AnnouncerApparatus["last"] = null;
    if (live.last) {
      const g = live.last.gymnast;
      const cat = data.categories.find((c) => c.id === g.categoryId) ?? data.categories[0];
      const row = cat?.apparatus[app]?.find((r) => r.gymnast.id === g.id);
      const aa = cat?.allAround.find((r) => r.gymnast.id === g.id);
      last = {
        gymnast: g,
        category: catOf(g.categoryId),
        attempt: live.last.attempt,
        total: live.last.score.total,
        d: live.last.score.d,
        e: live.last.score.e,
        neutral: live.last.score.neutral,
        rank: row?.rank ?? null,
        allAround: aa && !isFinal ? { rank: aa.rank, total: aa.total } : null,
      };
    }
    return {
      apparatus: app,
      current: live.current ? { ...live.current.gymnast, attempt: live.current.attempt, category: catOf(live.current.gymnast.categoryId) } : null,
      last,
      next,
      idle,
    };
  });
}

/** Открытые данные сервера в зале, заново при каждом новом снимке табло. */
export function usePublic<T>(path: string | null, version: string | undefined): T | null {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    fetch(path)
      .then((r) => (r.ok ? (r.json() as Promise<T>) : null))
      .then((v) => alive && v !== null && setValue(v))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [path, version]);
  return value;
}

const who = (g: { bib: number; lastName: string; firstName: string }) => `№${g.bib} ${g.lastName} ${g.firstName}`;
const details = (club: string | null, category: string) => [club, category].filter(Boolean).join(" · ");

/** Экран диктора: открывается с телефона или ноутбука по адресу табло с view=announcer. */
export function Announcer({ competitionId }: { competitionId: string }) {
  const { data, connected, error } = useBoard(competitionId, () => undefined);
  const version = data?.generatedAt;
  const rotation = usePublic<RotationView>(`/competitions/${competitionId}/rotation`, version);
  const finals = usePublic<FinalsView>(`/competitions/${competitionId}/finals`, version);
  const people = usePublic<Person[]>(`/competitions/${competitionId}/gymnasts`, version);
  const items = useMemo(
    () => (data ? announcerView(data, rotation, finals, people ?? []) : []),
    [data, rotation, finals, people],
  );

  if (!data) return <div className="center">{error ?? "Подключаемся к серверу…"}</div>;
  return (
    <div className="announcer">
      <header className="announcer-top">
        <div>
          <div className="title">{data.competition.name}</div>
          <div className="muted">Экран диктора{data.competition.phase === "FINAL" ? " · финалы" : ""}</div>
        </div>
        <span className={connected ? "dot ok" : "dot down"} title={connected ? "На связи" : "Нет связи"} />
      </header>
      <main className="announcer-grid">
        {items.map((a) => (
          <section key={a.apparatus} className="announcer-card">
            <h2>
              <ApparatusIcon code={a.apparatus} />
              {APPARATUS_NAMES[a.apparatus] ?? a.apparatus}
            </h2>
            <div className="announcer-row">
              <div className="label">Выступает</div>
              {a.current ? (
                <div>
                  <div className="big">
                    {who(a.current)}
                    {a.apparatus === "VT" && a.current.attempt === 2 ? " · второй прыжок" : ""}
                  </div>
                  <div className="muted">{details(a.current.club, a.current.category)}</div>
                </div>
              ) : (
                <div className="muted">Никого не вызвали</div>
              )}
            </div>
            <div className="announcer-row">
              <div className="label">Оценка</div>
              {a.last ? (
                <div>
                  <div>
                    {who(a.last.gymnast)}
                    {a.apparatus === "VT" ? ` · прыжок ${a.last.attempt}` : ""}
                  </div>
                  <div className="big score">{fmt(a.last.total)}</div>
                  <div className="muted">
                    D {fmt(a.last.d)} · E {fmt(a.last.e)}
                    {a.last.neutral > 0 ? ` · сбавка ${fmt(a.last.neutral)}` : ""}
                  </div>
                  <div>
                    {a.last.rank !== null && `Место на снаряде: ${a.last.rank}`}
                    {a.last.allAround && ` · в многоборье: ${a.last.allAround.rank} (${fmt(a.last.allAround.total)})`}
                    {a.last.category && <span className="muted"> · {a.last.category}</span>}
                  </div>
                </div>
              ) : (
                <div className="muted">Оценок пока нет</div>
              )}
            </div>
            <div className="announcer-row">
              <div className="label">Далее</div>
              {a.next.length > 0 ? (
                <ol>
                  {a.next.map((p) => (
                    <li key={p.id}>
                      {who(p)} <span className="muted">{details(p.club, p.category)}</span>
                    </li>
                  ))}
                </ol>
              ) : (
                <div className="muted">
                  {a.idle ? "Смены на этом снаряде сейчас нет" : data.competition.phase === "FINAL" ? "Финалисты выступили" : "Смена выступила на этом снаряде"}
                </div>
              )}
            </div>
          </section>
        ))}
      </main>
    </div>
  );
}
