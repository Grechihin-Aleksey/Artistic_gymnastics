import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { fromPoints, scoreCustomPerformance, scorePerformance, toPoints, type Discipline, type ScoreBreakdown } from "@ag/scoring";
import type {
  FinalsView,
  JudgeRole,
  MarkKind,
  PerformanceView,
  RotationView,
  Rules,
  RulesView,
  SubmitMarkInput,
} from "@ag/shared";
import { ApiError, apiRequest } from "./api";
import { ApparatusIcon } from "./ApparatusIcon";
import { Keypad } from "./Keypad";
import { Stopwatch } from "./Stopwatch";
import {
  APPARATUS_NAMES,
  KINDS_BY_ROLE,
  ROLE_NAMES,
  addDeduction,
  judgeLabel,
  kindName,
  eSpreadWarning,
  expandScore,
  timeLimit,
  parseScore,
  restHint,
} from "./labels";
import { MarkQueue, type Rejected, type SendOutcome } from "./markQueue";
import { useLive } from "./useLive";
import { uuid } from "./uuid";

interface PanelJudge {
  id: string;
  name: string;
  role: JudgeRole;
  seat: number;
}

interface Me {
  judge: {
    id: string;
    name: string;
    apparatus: string;
    role: JudgeRole;
    seat: number;
    competitionId: string;
    /** Один планшет на снаряд: старший судья вводит оценки всей бригады. */
    enterAllMarks?: boolean;
  };
  competition: {
    id: string;
    name: string;
    discipline: string;
    rules?: Rules;
    /** Своих правил: сбавки за требования для быстрого ввода. */
    deductions?: Deduction[];
  };
  panel?: PanelJudge[];
}

interface Deduction {
  name: string;
  value: number;
}

/**
 * Как считается итог на этом снаряде. По своим правилам d — сбавки за
 * требования, а база берётся по разряду участника; null — базы нет.
 */
type Scorer = (d: number, eDeductions: number[], neutral: number) => ScoreBreakdown | null;

function makeScorer(rules: Rules | undefined, base: number | null): Scorer {
  return (d, eDeductions, neutral) => {
    const e = eDeductions.map(toPoints);
    if (rules !== "CUSTOM") return scorePerformance({ d: toPoints(d), eDeductions: e, neutral: toPoints(neutral) });
    if (base === null) return null;
    return scoreCustomPerformance({ base: toPoints(base), requirements: toPoints(d), eDeductions: e, neutral: toPoints(neutral) });
  };
}

function describeScore(rules: Rules | undefined, score: ScoreBreakdown): string {
  const f = (p: number) => fromPoints(Math.abs(p)).toFixed(3);
  const neutral = score.neutral > 0 ? ` − ${f(score.neutral)}` : "";
  return rules === "CUSTOM"
    ? `стоимость ${f(score.d)} − сбавка ${f(score.e)}${neutral} = ${f(score.total)}`
    : `D ${f(score.d)} + E ${f(score.e)}${neutral} = ${f(score.total)}`;
}

interface Gymnast {
  id: string;
  bib: number;
  firstName: string;
  lastName: string;
  club: string | null;
  categoryId: string | null;
  /** Не явившихся и снявшихся не вызывают. */
  status?: "ACTIVE" | "DNS" | "WITHDRAWN";
}

export function JudgeScreen({ token, me, onLogout }: { token: string; me: Me; onLogout: () => void }) {
  const { judge, competition } = me;
  const [performances, setPerformances] = useState<PerformanceView[]>([]);
  const [gymnasts, setGymnasts] = useState<Map<string, Gymnast>>(new Map());
  const [rotation, setRotation] = useState<RotationView | null>(null);
  const [rulesView, setRulesView] = useState<RulesView | null>(null);
  const [finals, setFinals] = useState<FinalsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rules = rulesView?.rules ?? competition.rules;
  const deductions = rulesView?.deductions ?? competition.deductions ?? [];

  const queue = useMemo(
    () =>
      new MarkQueue(localStorage, `marks:${judge.id}`, async (mark): Promise<SendOutcome> => {
        try {
          await apiRequest("/marks", { token, method: "POST", body: mark });
          return { status: "ok" };
        } catch (e) {
          if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) {
            return { status: "rejected", reason: e.message };
          }
          return { status: "retry" };
        }
      }),
    [judge.id, token],
  );
  const queued = useSyncExternalStore(
    (cb) => queue.subscribe(cb),
    () => queue.items(),
  );

  const refresh = useCallback(async () => {
    try {
      const [list, people, rotationView, rulesNow, finalsNow] = await Promise.all([
        apiRequest<PerformanceView[]>(`/competitions/${competition.id}/performances?apparatus=${judge.apparatus}`, {
          token,
        }),
        apiRequest<Gymnast[]>(`/competitions/${competition.id}/gymnasts`),
        apiRequest<RotationView>(`/competitions/${competition.id}/rotation`),
        apiRequest<RulesView>(`/competitions/${competition.id}/rules`),
        apiRequest<FinalsView>(`/competitions/${competition.id}/finals`),
      ]);
      setRulesView(rulesNow);
      setFinals(finalsNow);
      setPerformances(list);
      setGymnasts(new Map(people.map((g) => [g.id, g])));
      setRotation(rotationView);
    } catch {
      // покажем старые данные; индикатор связи скажет, что сервер недоступен
    }
  }, [competition.id, judge.apparatus, token]);

  const flush = useCallback(async () => {
    const rejected: Rejected[] = await queue.flush();
    if (rejected.length > 0) setError(rejected.map((r) => `${kindName(r.mark.kind, rules)}: ${r.reason}`).join("; "));
  }, [queue, rules]);

  const onLive = useCallback(() => {
    void refresh();
    void flush();
  }, [refresh, flush]);
  const connected = useLive(token, onLive);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void flush(), 3000);
    return () => clearInterval(timer);
  }, [refresh, flush]);

  const current = [...performances].reverse().find((p) => p.status === "SCORING") ?? null;
  const currentGymnast = current ? gymnasts.get(current.gymnastId) : undefined;
  const category = rulesView?.categories.find((c) => c.id === currentGymnast?.categoryId);
  const base = category ? (category.apparatus[judge.apparatus as keyof typeof category.apparatus] ?? category.base) : null;
  const scorer = makeScorer(rules, base);
  const limit = timeLimit(competition.discipline, judge.apparatus);
  const baseNote =
    rules !== "CUSTOM" || !current
      ? null
      : base !== null
        ? `${category!.name} · база ${base.toFixed(3)}`
        : category
          ? `Для разряда «${category.name}» не задана база: секретариат задаёт её в правилах`
          : "У участника не указан разряд: базу взять неоткуда";
  // Во время финалов в очереди только финалисты снаряда, а выступившими считаются по финальным выступлениям.
  const phase = finals?.phase ?? "QUAL";
  const stagePerformances = performances.filter((p) => (p.stage ?? "QUAL") === phase);
  const finalLists = phase === "FINAL" ? (finals?.lists.filter((l) => l.apparatus === judge.apparatus) ?? []) : null;
  const lastApproved = [...performances].reverse().find((p) => p.status === "APPROVED") ?? null;

  const submit = (kind: MarkKind, value: number) => {
    if (!current) return;
    setError(null);
    const mark: SubmitMarkInput = { id: uuid(), performanceId: current.id, kind, value };
    queue.enqueue(mark);
    void flush().then(refresh);
  };

  return (
    <div className="screen">
      <header className="bar">
        <div>
          <div className="apparatus">
            <ApparatusIcon code={judge.apparatus} />
            {APPARATUS_NAMES[judge.apparatus] ?? judge.apparatus}
            {phase === "FINAL" && <span className="stage-badge">Финал</span>}
          </div>
          <div className="muted">
            {judge.role === "SUPERVISOR" ? ROLE_NAMES.SUPERVISOR : judgeLabel(judge.role, judge.seat)} · {judge.name} ·{" "}
            {competition.name}
          </div>
        </div>
        <div className="status">
          <span className={connected ? "dot ok" : "dot down"} />
          {connected ? "На связи" : "Нет связи"}
          {queued.length > 0 && <span className="badge">не отправлено: {queued.length}</span>}
          <button type="button" className="link" onClick={onLogout}>
            Выйти
          </button>
        </div>
      </header>

      {error && <div className="alert">{error}</div>}

      {current ? (
        <main className="work">
          <GymnastCard gymnast={currentGymnast} performance={current} note={baseNote} />
          {judge.role === "SUPERVISOR" && limit !== null && <Stopwatch key={current.id} limit={limit} />}
          {judge.enterAllMarks ? (
            <TabletScoring
              key={current.id}
              token={token}
              performance={current}
              panel={me.panel ?? []}
              rules={rules}
              deductions={deductions}
              scorer={scorer}
              onDone={refresh}
            />
          ) : (
            <>
              <div className="inputs">
                {KINDS_BY_ROLE[judge.role].map((kind) => (
                  <MarkInput
                    key={`${current.id}:${kind}`}
                    kind={kind}
                    rules={rules}
                    deductions={kind === "D" && rules === "CUSTOM" ? deductions : []}
                    sent={current.marks.find((m) => m.judgeId === judge.id && m.kind === kind)?.value}
                    pending={queued.find((m) => m.performanceId === current.id && m.kind === kind)?.value}
                    onSubmit={(value) => submit(kind, value)}
                  />
                ))}
              </div>
              {judge.role === "SUPERVISOR" && (
                <SupervisorPanel token={token} performance={current} rules={rules} scorer={scorer} onDone={refresh} />
              )}
            </>
          )}
        </main>
      ) : (
        <main className="waiting">
          <p>{judge.role === "SUPERVISOR" ? "Вызовите следующего участника" : "Ожидаем вызова участника"}</p>
          {lastApproved?.score && (
            <p className="muted">
              Последний итог: {gymnasts.get(lastApproved.gymnastId)?.lastName ?? ""} —{" "}
              <strong>{lastApproved.score.total.toFixed(3)}</strong>
            </p>
          )}
          {judge.role === "SUPERVISOR" && (
            <CallPanel
              token={token}
              competitionId={competition.id}
              apparatus={judge.apparatus}
              discipline={competition.discipline as Discipline}
              performances={stagePerformances}
              gymnasts={gymnasts}
              rotation={rotation}
              finalLists={finalLists}
              categoryNames={new Map(rulesView?.categories.map((c) => [c.id, c.name]))}
              justFinished={lastApproved}
              onDone={refresh}
            />
          )}
        </main>
      )}
    </div>
  );
}

function GymnastCard({
  gymnast,
  performance,
  note,
}: {
  gymnast: Gymnast | undefined;
  performance: PerformanceView;
  note: string | null;
}) {
  return (
    <section className="gymnast">
      <div className="bib">№{gymnast?.bib ?? "?"}</div>
      <div>
        <div className="name">{gymnast ? `${gymnast.lastName} ${gymnast.firstName}` : "Участник"}</div>
        <div className="muted">
          {gymnast?.club ?? ""}
          {performance.apparatus === "VT" && ` · прыжок ${performance.attempt}`}
        </div>
        {note && <div className="muted base-note">{note}</div>}
      </div>
    </section>
  );
}

/** Кнопки сбавок за требования из списка секретариата: нажатие прибавляет сбавку. */
function DeductionChips({ deductions, onAdd }: { deductions: Deduction[]; onAdd: (value: number) => void }) {
  if (deductions.length === 0) return null;
  return (
    <div className="chips">
      {deductions.map((d) => (
        <button key={`${d.name}:${d.value}`} type="button" onClick={() => onAdd(d.value)}>
          {d.name} <strong>−{d.value}</strong>
        </button>
      ))}
    </div>
  );
}

function MarkInput({
  kind,
  rules,
  deductions,
  sent,
  pending,
  onSubmit,
}: {
  kind: MarkKind;
  rules: Rules | undefined;
  deductions: Deduction[];
  sent: number | undefined;
  pending: number | undefined;
  onSubmit: (value: number) => void;
}) {
  const [text, setText] = useState("");
  const shown = expandScore(text);
  const value = parseScore(shown, kind);
  return (
    <section className="mark">
      <h2>{kindName(kind, rules)}</h2>
      <div className={value === null && text ? "display invalid" : "display"}>{shown || "—"}</div>
      <DeductionChips deductions={deductions} onAdd={(v) => setText((t) => addDeduction(t, v))} />
      <Keypad value={text} onChange={setText} />
      <button
        type="button"
        className="primary"
        disabled={value === null}
        onClick={() => {
          if (value === null) return;
          onSubmit(value);
          setText("");
        }}
      >
        Отправить
      </button>
      <div className="muted">
        {pending !== undefined
          ? `Ждёт отправки: ${pending.toFixed(3)}`
          : sent !== undefined
            ? `Принято сервером: ${sent.toFixed(3)}`
            : "Оценка ещё не отправлена"}
      </div>
    </section>
  );
}

function SupervisorPanel({
  token,
  performance,
  rules,
  scorer,
  onDone,
}: {
  token: string;
  performance: PerformanceView;
  rules: Rules | undefined;
  scorer: Scorer;
  onDone: () => Promise<void>;
}) {
  const custom = rules === "CUSTOM";
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const d = performance.marks.filter((m) => m.kind === "D");
  const e = performance.marks.filter((m) => m.kind === "E");
  const neutral = performance.marks.filter((m) => m.kind === "NEUTRAL");
  const spread = eSpreadWarning(e.map((m) => m.value));

  let preview: string | null = null;
  const dValues = new Set(d.map((m) => m.value));
  // По своим правилам без сбавок за требования считаем их нулевыми.
  const dReady = dValues.size === 1 || (custom && dValues.size === 0);
  if (dReady && e.length > 0) {
    const score = scorer(
      [...dValues][0] ?? 0,
      e.map((m) => m.value),
      neutral[0]?.value ?? 0,
    );
    if (score) preview = describeScore(rules, score);
  }

  const approve = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await apiRequest(`/performances/${performance.id}/approve`, { token, method: "POST" });
      await onDone();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Не удалось утвердить");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="supervisor">
      <h2>Оценки бригады</h2>
      <table>
        <tbody>
          {performance.marks.map((m) => (
            <tr key={`${m.judgeId}:${m.kind}`}>
              <td>{judgeLabel(m.role, m.seat)}</td>
              <td>{kindName(m.kind, rules)}</td>
              <td className="num">{m.value.toFixed(3)}</td>
            </tr>
          ))}
          {performance.marks.length === 0 && (
            <tr>
              <td className="muted">Оценок пока нет</td>
            </tr>
          )}
        </tbody>
      </table>
      {dValues.size > 1 && (
        <div className="alert">{custom ? "Сбавки за требования у судей расходятся" : "Оценки D у судей расходятся"}</div>
      )}
      {spread && <div className="warning">{spread}</div>}
      {preview && <div className="preview">Предварительно: {preview}</div>}
      {message && <div className="alert">{message}</div>}
      <button type="button" className="primary approve" disabled={busy || !dReady} onClick={approve}>
        Утвердить
      </button>
    </section>
  );
}

/**
 * Один планшет на снаряд: оценки всей бригады вводятся здесь по карточкам судей.
 * Оценки записываются за судьями бригады, итог утверждается одной кнопкой.
 */
function TabletScoring({
  token,
  performance,
  panel,
  rules,
  deductions,
  scorer,
  onDone,
}: {
  token: string;
  performance: PerformanceView;
  panel: PanelJudge[];
  rules: Rules | undefined;
  deductions: Deduction[];
  scorer: Scorer;
  onDone: () => Promise<void>;
}) {
  const custom = rules === "CUSTOM";
  const eJudges = panel.filter((j) => j.role === "E").sort((a, b) => a.seat - b.seat);
  const dJudge = panel.find((j) => j.role === "D");
  const [d, setD] = useState("");
  const [e, setE] = useState<string[]>(() => eJudges.map(() => ""));
  const [neutral, setNeutral] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Запятая вместо точки и быстрый ввод без точки: «95» — это 9.50.
  const read = (text: string, kind: MarkKind) => parseScore(expandScore(text), kind);
  // По своим правилам пустое поле требований — сбавок нет.
  const dValue = custom && !d.trim() ? 0 : read(d, "D");
  const eValues = e.map((x) => read(x, "E"));
  const neutralValue = neutral.trim() ? read(neutral, "NEUTRAL") : 0;
  const complete =
    dValue !== null && eValues.every((v): v is number => v !== null) && neutralValue !== null && eJudges.length > 0;

  const spread = eSpreadWarning(eValues.filter((v): v is number => v !== null && v !== undefined));

  let preview: string | null = null;
  if (complete) {
    const score = scorer(dValue, eValues as number[], neutralValue);
    if (score) preview = describeScore(rules, score);
  }

  const approve = async () => {
    if (!complete) return;
    setBusy(true);
    setMessage(null);
    try {
      await apiRequest(`/performances/${performance.id}/tablet-score`, {
        token,
        method: "POST",
        body: { d: dValue, e: eValues, ...(neutralValue ? { neutral: neutralValue } : {}) },
      });
      await onDone();
    } catch (err) {
      setMessage(err instanceof ApiError && err.status === 0 ? "Нет связи с сервером, оценки сохранены на экране" : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Enter переводит к следующему полю, на последнем — утверждает.
  const next = (ev: React.KeyboardEvent<HTMLInputElement>) => {
    if (ev.key !== "Enter") return;
    ev.preventDefault();
    const fields = [...document.querySelectorAll<HTMLInputElement>(".tablet input")];
    const i = fields.indexOf(ev.currentTarget);
    if (i + 1 < fields.length) fields[i + 1]!.focus();
    else void approve();
  };

  if ((!dJudge && !custom) || eJudges.length === 0) {
    return (
      <section className="tablet">
        <div className="alert">
          Секретариат ещё не завёл судей {custom ? "E" : "D и E"} этого снаряда. Их фамилии и оценки идут в протокол.
          Заведите их в секретариате на вкладке «Судьи»: снаряд этот же, роль «Судья {custom ? "E" : "D» и «Судья E"}», QR-коды им
          не нужны. Потом обновите эту страницу.
        </div>
      </section>
    );
  }

  const field = (label: string, value: string, onChange: (v: string) => void, valid: boolean, autoFocus = false) => (
    <label className={value && !valid ? "invalid" : undefined}>
      <span>{label}</span>
      <input
        inputMode="decimal"
        autoComplete="off"
        value={value}
        autoFocus={autoFocus}
        onKeyDown={next}
        onChange={(ev) => onChange(ev.target.value)}
        // Уходя из поля, судья видит оценку так, как она уйдёт в протокол.
        onBlur={() => valid && value.trim() && onChange(expandScore(value))}
      />
    </label>
  );

  return (
    <section className="tablet">
      <h2>Оценки бригады</h2>
      <div className="tablet-grid">
        {field(
          custom ? `Сбавка за требования${dJudge ? ` · ${dJudge.name}` : ""}` : `D · ${dJudge!.name}`,
          d,
          setD,
          dValue !== null,
          true,
        )}
        {eJudges.map((j, i) =>
          field(
            `E${j.seat} · ${j.name}`,
            e[i]!,
            (v) => setE((list) => list.map((x, k) => (k === i ? v : x))),
            eValues[i] !== null,
          ),
        )}
        {field("Нейтральная сбавка", neutral, setNeutral, neutralValue !== null)}
      </div>
      {custom && <DeductionChips deductions={deductions} onAdd={(v) => setD((t) => addDeduction(t, v))} />}
      {spread && <div className="warning">{spread}</div>}
      {preview && <div className="preview">Итог: {preview}</div>}
      {message && <div className="alert">{message}</div>}
      <button type="button" className="primary approve" disabled={busy || !complete} onClick={() => void approve()}>
        Утвердить
      </button>
    </section>
  );
}

/**
 * Старший судья вызывает следующего участника. В списке те, кто ещё не выступал
 * на этом снаряде, по номерам; на опорном прыжке — ещё и вторая попытка.
 */
function CallPanel({
  token,
  competitionId,
  apparatus,
  discipline,
  performances,
  gymnasts,
  rotation,
  finalLists,
  categoryNames,
  justFinished,
  onDone,
}: {
  token: string;
  competitionId: string;
  apparatus: string;
  discipline: Discipline;
  performances: PerformanceView[];
  gymnasts: Map<string, Gymnast>;
  rotation: RotationView | null;
  /** Идут финалы: составы финала на этом снаряде по разрядам, в порядке выступления. */
  finalLists: FinalsView["lists"] | null;
  /** Названия разрядов: в смене бывают участники разных разрядов. */
  categoryNames: Map<string, string>;
  /** Последнее утверждённое выступление: после первого прыжка спрашиваем, будет ли второй. */
  justFinished: PerformanceView | null;
  onDone: () => Promise<void>;
}) {
  const [filter, setFilter] = useState("");
  const [noSecond, setNoSecond] = useState<Set<string>>(() => new Set());
  const [showAll, setShowAll] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Смены, которые в этой ротации стоят на снаряде, в порядке выхода.
  const shiftsHere = rotation?.shifts.filter((s) => s.apparatus === apparatus) ?? [];
  const isFinal = finalLists !== null;
  const byShift = !isFinal && rotation !== null && rotation.shifts.length > 0 && !showAll;
  // В финале участник выступает в своём разряде: подпишем разряд, если финалов несколько.
  const finalCategory = new Map<string, string>();

  const firstDone = new Set(performances.filter((p) => p.attempt === 1).map((p) => p.gymnastId));
  const secondDone = new Set(performances.filter((p) => p.attempt === 2).map((p) => p.gymnastId));
  const approvedFirst = new Set(
    performances.filter((p) => p.attempt === 1 && p.status === "APPROVED").map((p) => p.gymnastId),
  );
  const matches = (g: Gymnast) =>
    !filter || String(g.bib).startsWith(filter) || g.lastName.toLowerCase().startsWith(filter.toLowerCase());
  const finalists = (finalLists ?? []).flatMap((l) =>
    l.finalists
      .filter((f) => !f.reserve)
      .map((f) => {
        if (finalLists!.length > 1 && l.category.name) finalCategory.set(f.gymnast.id, l.category.name);
        return gymnasts.get(f.gymnast.id);
      })
      .filter((g): g is Gymnast => Boolean(g) && (g!.status ?? "ACTIVE") === "ACTIVE"),
  );
  const everyone = isFinal
    ? finalists
    : byShift
    ? shiftsHere.flatMap((s) => s.gymnastIds.map((id) => gymnasts.get(id)).filter((g): g is Gymnast => Boolean(g)))
    : [...gymnasts.values()].filter((g) => (g.status ?? "ACTIVE") === "ACTIVE").sort((a, b) => a.bib - b.bib);
  const first = everyone.filter((g) => !firstDone.has(g.id) && matches(g));
  // Второй прыжок — по желанию (на финал в опорном прыжке), он не держит смену.
  const second =
    apparatus === "VT" ? everyone.filter((g) => approvedFirst.has(g.id) && !secondDone.has(g.id) && matches(g)) : [];

  let empty = "Все участники выступили на этом снаряде";
  if (filter) empty = "Никого не найдено";
  else if (isFinal && finalists.length === 0) empty = "Финала на этом снаряде нет";
  else if (isFinal) empty = "Все финалисты выступили";
  else if (byShift && shiftsHere.length === 0) empty = restHint(rotation!, discipline, apparatus);
  else if (byShift) empty = "Смена выступила на этом снаряде. Ждём перехода на следующую ротацию.";

  const call = async (gymnast: Gymnast, attempt: number) => {
    setBusy(true);
    setMessage(null);
    try {
      await apiRequest(`/competitions/${competitionId}/performances`, {
        token,
        method: "POST",
        body: { gymnastId: gymnast.id, apparatus, attempt },
      });
      setFilter("");
      await onDone();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Не удалось вызвать участника");
    } finally {
      setBusy(false);
    }
  };

  // Только что утверждён первый прыжок: старший сразу решает, будет ли второй.
  const askSecond =
    apparatus === "VT" &&
    justFinished !== null &&
    justFinished.apparatus === "VT" &&
    justFinished.attempt === 1 &&
    performances.some((p) => p.id === justFinished.id) &&
    !secondDone.has(justFinished.gymnastId) &&
    !noSecond.has(justFinished.id)
      ? gymnasts.get(justFinished.gymnastId)
      : undefined;

  return (
    <section className="call">
      {askSecond && (
        <div className="second-ask">
          <p>
            <strong>
              №{askSecond.bib} {askSecond.lastName} {askSecond.firstName}
            </strong>{" "}
            — первый прыжок {justFinished!.score ? justFinished!.score.total.toFixed(3) : ""}. Будет второй прыжок?
          </p>
          <div className="buttons">
            <button type="button" className="primary" disabled={busy} onClick={() => void call(askSecond, 2)}>
              Да, второй прыжок
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setNoSecond((set) => new Set(set).add(justFinished!.id))}
            >
              Нет, следующий участник
            </button>
          </div>
        </div>
      )}
      {isFinal && (
        <div className="call-shift">
          <span>Финал · порядок по жеребьёвке</span>
        </div>
      )}
      {!isFinal && rotation && rotation.shifts.length > 0 && (
        <div className="call-shift">
          <span>
            {shiftsHere.length > 0
              ? `Смена ${shiftsHere.map((s) => s.number).join(", ")}`
              : "Смены нет"}{" "}
            · ротация {rotation.rotation + 1} из {rotation.rotations}
          </span>
          <button type="button" className="link" onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Только смена" : "Все участники"}
          </button>
        </div>
      )}
      <input
        className="call-filter"
        inputMode="numeric"
        placeholder="№ или фамилия"
        value={filter}
        onChange={(e) => setFilter(e.target.value.trim())}
      />
      {message && <div className="alert">{message}</div>}
      {first.length === 0 && <p className="muted">{empty}</p>}
      {first.length > 0 && (
        <ul>
          {first.slice(0, 30).map((gymnast, i) => (
            <li key={gymnast.id}>
              <button
                type="button"
                className={(byShift || isFinal) && i === 0 && !filter ? "next" : undefined}
                disabled={busy}
                onClick={() => void call(gymnast, 1)}
              >
                <strong>№{gymnast.bib}</strong> {gymnast.lastName} {gymnast.firstName}
                {isFinal
                  ? finalCategory.has(gymnast.id) && <span className="muted"> · {finalCategory.get(gymnast.id)}</span>
                  : gymnast.categoryId &&
                    categoryNames.has(gymnast.categoryId) && (
                      <span className="muted"> · {categoryNames.get(gymnast.categoryId)}</span>
                    )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {second.length > 0 && (
        <details className="second-vault" open={first.length === 0 && !byShift}>
          <summary>Второй прыжок: {second.length}</summary>
          <ul>
            {second.slice(0, 30).map((gymnast) => (
              <li key={gymnast.id}>
                <button type="button" disabled={busy} onClick={() => void call(gymnast, 2)}>
                  <strong>№{gymnast.bib}</strong> {gymnast.lastName} {gymnast.firstName}
                  <span className="muted"> · второй прыжок</span>
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
