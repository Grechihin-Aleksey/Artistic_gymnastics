import { useCallback, useEffect, useMemo, useState } from "react";
import { apparatusFor, type Discipline } from "@ag/scoring";
import { eToleranceFor, type InquiryView, type PerformanceView, type RulesView } from "@ag/shared";
import { ApparatusIcon } from "./ApparatusIcon";
import { apiRequest } from "./api";
import { APPARATUS_NAMES } from "./labels";
import { useCompetitionLive } from "./useLive";

/** Оценку ставят дольше этого — повод подойти к бригаде. */
export const SLOW_SCORING_MS = 120_000;

interface Gymnast {
  id: string;
  bib: number;
  firstName: string;
  lastName: string;
}

interface PanelJudge {
  id: string;
  apparatus: string;
  role: "SUPERVISOR" | "D" | "E";
  seat: number;
  enterAllMarks: boolean;
}

export interface ChiefFlag {
  kind: "spread" | "slow" | "neutral" | "inquiry";
  apparatus: string;
  gymnastId: string;
  text: string;
  /** Для сортировки: новые сверху. */
  at: number;
}

export interface ChiefApparatus {
  apparatus: string;
  current: PerformanceView | null;
  /** Сколько оценок E уже пришло и сколько судей E в бригаде. */
  eReceived: number;
  eJudges: number;
  last: PerformanceView | null;
}

const fmt = (n: number) => n.toFixed(3);

/** Что главному судье стоит проверить: расхождения E, долгие оценки, нейтральные сбавки, запросы тренеров. */
export function chiefFlags(
  performances: readonly PerformanceView[],
  inquiries: readonly InquiryView[],
  rules: RulesView | null,
  now: number,
): ChiefFlag[] {
  const flags: ChiefFlag[] = [];
  for (const p of performances) {
    const at = new Date(p.approvedAt ?? p.calledAt ?? 0).getTime();
    if (p.status === "SCORING" && p.calledAt && now - new Date(p.calledAt).getTime() > SLOW_SCORING_MS) {
      const minutes = Math.floor((now - new Date(p.calledAt).getTime()) / 60_000);
      flags.push({ kind: "slow", apparatus: p.apparatus, gymnastId: p.gymnastId, at: now, text: `оценку ставят уже ${minutes} мин` });
    }
    if (p.status !== "APPROVED") continue;
    const e = p.marks.filter((m) => m.kind === "E").map((m) => m.value);
    if (e.length >= 2) {
      const spread = Math.round((Math.max(...e) - Math.min(...e)) * 1000) / 1000;
      const tolerance = eToleranceFor(rules, e);
      if (spread > tolerance + 1e-9) {
        flags.push({
          kind: "spread",
          apparatus: p.apparatus,
          gymnastId: p.gymnastId,
          at,
          text: `сбавки E расходятся на ${spread.toFixed(2)} (допуск ${tolerance.toFixed(2)}): ${e.map((v) => v.toFixed(1)).join(" · ")}`,
        });
      }
    }
    if ((p.score?.neutral ?? 0) > 0) {
      flags.push({ kind: "neutral", apparatus: p.apparatus, gymnastId: p.gymnastId, at, text: `нейтральная сбавка ${p.score!.neutral.toFixed(2)}` });
    }
  }
  for (const i of inquiries) {
    if (i.status !== "PENDING") continue;
    flags.push({
      kind: "inquiry",
      apparatus: i.apparatus,
      gymnastId: i.gymnast.id,
      at: now + 1,
      text: `запрос тренера ${i.coach} на пересмотр D ждёт решения${i.late ? " (подан с опозданием)" : ""}`,
    });
  }
  return flags.sort((a, b) => b.at - a.at);
}

export function chiefApparatus(discipline: Discipline, performances: readonly PerformanceView[], panel: readonly PanelJudge[]): ChiefApparatus[] {
  return apparatusFor(discipline).map((apparatus) => {
    const here = performances.filter((p) => p.apparatus === apparatus);
    const current = [...here].reverse().find((p) => p.status === "SCORING") ?? null;
    const last = [...here].filter((p) => p.status === "APPROVED").sort((a, b) => (a.approvedAt ?? "").localeCompare(b.approvedAt ?? "")).at(-1) ?? null;
    return {
      apparatus,
      current,
      eReceived: current ? current.marks.filter((m) => m.kind === "E").length : 0,
      eJudges: panel.filter((j) => j.apparatus === apparatus && j.role === "E").length,
      last,
    };
  });
}

const FLAG_LABEL: Record<ChiefFlag["kind"], string> = {
  inquiry: "Запрос",
  slow: "Долго",
  spread: "Расхождение E",
  neutral: "Сбавка",
};

/** Экран главного судьи: все снаряды сразу и что стоит проверить. Обновляется сам. */
export function ChiefJudgePanel({
  competitionId,
  discipline,
  adminToken,
  onError,
  active,
}: {
  competitionId: string;
  discipline: Discipline;
  adminToken: string;
  onError: (m: string | null) => void;
  active: boolean;
}) {
  const [performances, setPerformances] = useState<PerformanceView[]>([]);
  const [inquiries, setInquiries] = useState<InquiryView[]>([]);
  const [rules, setRules] = useState<RulesView | null>(null);
  const [gymnasts, setGymnasts] = useState<Map<string, Gymnast>>(new Map());
  const [panel, setPanel] = useState<PanelJudge[]>([]);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const [list, inq, r, people, judges] = await Promise.all([
        apiRequest<PerformanceView[]>(`/competitions/${competitionId}/performances`, { token: adminToken }),
        apiRequest<InquiryView[]>(`/competitions/${competitionId}/inquiries`, { token: adminToken }),
        apiRequest<RulesView>(`/competitions/${competitionId}/rules`),
        apiRequest<Gymnast[]>(`/competitions/${competitionId}/gymnasts`),
        apiRequest<PanelJudge[]>(`/competitions/${competitionId}/judges`, { token: adminToken }),
      ]);
      setPerformances(list);
      setInquiries(inq);
      setRules(r);
      setGymnasts(new Map(people.map((g) => [g.id, g])));
      setPanel(judges);
      setNow(Date.now());
    } catch (e) {
      onError((e as Error).message);
    }
  }, [competitionId, adminToken, onError]);

  useCompetitionLive(competitionId, active, load);
  useEffect(() => {
    if (!active) return;
    void load();
    // Время «оценку ставят уже N мин» растёт и без событий.
    const t = setInterval(() => setNow(Date.now()), 5000);
    const poll = setInterval(() => void load(), 30_000);
    return () => {
      clearInterval(t);
      clearInterval(poll);
    };
  }, [active, load]);

  const cards = useMemo(() => chiefApparatus(discipline, performances, panel), [discipline, performances, panel]);
  const flags = useMemo(() => chiefFlags(performances, inquiries, rules, now), [performances, inquiries, rules, now]);
  const who = (id: string) => {
    const g = gymnasts.get(id);
    return g ? `№${g.bib} ${g.lastName} ${g.firstName}` : "участник";
  };

  return (
    <div className="chief">
      <section className="panel no-print">
        <h2>Сейчас на снарядах</h2>
        <div className="wide chief-grid">
          {cards.map((c) => {
            const slow = c.current?.calledAt ? now - new Date(c.current.calledAt).getTime() > SLOW_SCORING_MS : false;
            return (
              <div key={c.apparatus} className="chief-card">
                <h3>
                  <ApparatusIcon code={c.apparatus} />
                  {APPARATUS_NAMES[c.apparatus]}
                </h3>
                {c.current ? (
                  <p>
                    <strong>{who(c.current.gymnastId)}</strong>
                    <br />
                    <span className={slow ? "warning-text" : "muted"}>
                      оценки E: {c.eReceived} из {c.eJudges}
                      {c.current.calledAt && ` · ${Math.floor((now - new Date(c.current.calledAt).getTime()) / 1000 / 60)}:${String(Math.floor(((now - new Date(c.current.calledAt).getTime()) / 1000) % 60)).padStart(2, "0")} с вызова`}
                    </span>
                  </p>
                ) : (
                  <p className="muted">Никого не вызвали</p>
                )}
                {c.last?.score && (
                  <p className="muted">
                    Последняя: {who(c.last.gymnastId)} — <strong>{fmt(c.last.score.total)}</strong> (D {fmt(c.last.score.d)} · E{" "}
                    {fmt(c.last.score.e)}
                    {c.last.score.neutral > 0 ? ` · −${c.last.score.neutral.toFixed(2)}` : ""})
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </section>
      <section className="panel no-print">
        <h2>Что проверить{flags.length > 0 ? `: ${flags.length}` : ""}</h2>
        {flags.length === 0 ? (
          <p className="muted wide">Пока всё спокойно: расхождений E сверх допуска, долгих оценок и запросов тренеров нет.</p>
        ) : (
          <table className="wide chief-flags">
            <tbody>
              {flags.map((f, i) => (
                <tr key={i} className={`chief-${f.kind}`}>
                  <td>
                    <span className="chief-tag">{FLAG_LABEL[f.kind]}</span>
                  </td>
                  <td>{APPARATUS_NAMES[f.apparatus]}</td>
                  <td>{who(f.gymnastId)}</td>
                  <td>{f.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted wide">
          Расхождение E считается по допуску из «Правил судейства». Запросы тренеров разбирают на экране «Ход соревнования»,
          оценку исправляют там же, в блоке «Ввод оценок с судейских листов».
        </p>
      </section>
    </div>
  );
}
