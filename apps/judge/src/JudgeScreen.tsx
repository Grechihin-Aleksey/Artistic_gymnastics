import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { fromPoints, scorePerformance, toPoints } from "@ag/scoring";
import type { JudgeRole, MarkKind, PerformanceView, RotationView, SubmitMarkInput } from "@ag/shared";
import { ApiError, apiRequest } from "./api";
import { Keypad } from "./Keypad";
import { APPARATUS_NAMES, KIND_NAMES, KINDS_BY_ROLE, ROLE_NAMES, judgeLabel, parseScore } from "./labels";
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
  competition: { id: string; name: string; discipline: string };
  panel?: PanelJudge[];
}

interface Gymnast {
  id: string;
  bib: number;
  firstName: string;
  lastName: string;
  club: string | null;
}

export function JudgeScreen({ token, me, onLogout }: { token: string; me: Me; onLogout: () => void }) {
  const { judge, competition } = me;
  const [performances, setPerformances] = useState<PerformanceView[]>([]);
  const [gymnasts, setGymnasts] = useState<Map<string, Gymnast>>(new Map());
  const [rotation, setRotation] = useState<RotationView | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      const [list, people, rotationView] = await Promise.all([
        apiRequest<PerformanceView[]>(`/competitions/${competition.id}/performances?apparatus=${judge.apparatus}`, {
          token,
        }),
        apiRequest<Gymnast[]>(`/competitions/${competition.id}/gymnasts`),
        apiRequest<RotationView>(`/competitions/${competition.id}/rotation`),
      ]);
      setPerformances(list);
      setGymnasts(new Map(people.map((g) => [g.id, g])));
      setRotation(rotationView);
    } catch {
      // покажем старые данные; индикатор связи скажет, что сервер недоступен
    }
  }, [competition.id, judge.apparatus, token]);

  const flush = useCallback(async () => {
    const rejected: Rejected[] = await queue.flush();
    if (rejected.length > 0) setError(rejected.map((r) => `${KIND_NAMES[r.mark.kind]}: ${r.reason}`).join("; "));
  }, [queue]);

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
          <div className="apparatus">{APPARATUS_NAMES[judge.apparatus] ?? judge.apparatus}</div>
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
          <GymnastCard gymnast={gymnasts.get(current.gymnastId)} performance={current} />
          {judge.enterAllMarks ? (
            <TabletScoring
              key={current.id}
              token={token}
              performance={current}
              panel={me.panel ?? []}
              onDone={refresh}
            />
          ) : (
            <>
              <div className="inputs">
                {KINDS_BY_ROLE[judge.role].map((kind) => (
                  <MarkInput
                    key={`${current.id}:${kind}`}
                    kind={kind}
                    sent={current.marks.find((m) => m.judgeId === judge.id && m.kind === kind)?.value}
                    pending={queued.find((m) => m.performanceId === current.id && m.kind === kind)?.value}
                    onSubmit={(value) => submit(kind, value)}
                  />
                ))}
              </div>
              {judge.role === "SUPERVISOR" && <SupervisorPanel token={token} performance={current} onDone={refresh} />}
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
              performances={performances}
              gymnasts={gymnasts}
              rotation={rotation}
              onDone={refresh}
            />
          )}
        </main>
      )}
    </div>
  );
}

function GymnastCard({ gymnast, performance }: { gymnast: Gymnast | undefined; performance: PerformanceView }) {
  return (
    <section className="gymnast">
      <div className="bib">№{gymnast?.bib ?? "?"}</div>
      <div>
        <div className="name">{gymnast ? `${gymnast.lastName} ${gymnast.firstName}` : "Участник"}</div>
        <div className="muted">
          {gymnast?.club ?? ""}
          {performance.apparatus === "VT" && ` · прыжок ${performance.attempt}`}
        </div>
      </div>
    </section>
  );
}

function MarkInput({
  kind,
  sent,
  pending,
  onSubmit,
}: {
  kind: MarkKind;
  sent: number | undefined;
  pending: number | undefined;
  onSubmit: (value: number) => void;
}) {
  const [text, setText] = useState("");
  const value = parseScore(text, kind);
  return (
    <section className="mark">
      <h2>{KIND_NAMES[kind]}</h2>
      <div className={value === null && text ? "display invalid" : "display"}>{text || "—"}</div>
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
  onDone,
}: {
  token: string;
  performance: PerformanceView;
  onDone: () => Promise<void>;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const d = performance.marks.filter((m) => m.kind === "D");
  const e = performance.marks.filter((m) => m.kind === "E");
  const neutral = performance.marks.filter((m) => m.kind === "NEUTRAL");

  let preview: string | null = null;
  const dValues = new Set(d.map((m) => m.value));
  if (dValues.size === 1 && e.length > 0) {
    const score = scorePerformance({
      d: toPoints([...dValues][0]!),
      eDeductions: e.map((m) => toPoints(m.value)),
      neutral: toPoints(neutral[0]?.value ?? 0),
    });
    preview = `D ${fromPoints(score.d).toFixed(3)} + E ${fromPoints(score.e).toFixed(3)} − ${fromPoints(score.neutral).toFixed(3)} = ${fromPoints(score.total).toFixed(3)}`;
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
              <td>{KIND_NAMES[m.kind]}</td>
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
      {dValues.size > 1 && <div className="alert">Оценки D у судей расходятся</div>}
      {preview && <div className="preview">Предварительно: {preview}</div>}
      {message && <div className="alert">{message}</div>}
      <button type="button" className="primary approve" disabled={busy || dValues.size !== 1} onClick={approve}>
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
  onDone,
}: {
  token: string;
  performance: PerformanceView;
  panel: PanelJudge[];
  onDone: () => Promise<void>;
}) {
  const eJudges = panel.filter((j) => j.role === "E").sort((a, b) => a.seat - b.seat);
  const dJudge = panel.find((j) => j.role === "D");
  const [d, setD] = useState("");
  const [e, setE] = useState<string[]>(() => eJudges.map(() => ""));
  const [neutral, setNeutral] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // На планшете с русской раскладкой вместо точки часто ставят запятую.
  const read = (text: string, kind: MarkKind) => parseScore(text.trim().replace(",", "."), kind);
  const dValue = read(d, "D");
  const eValues = e.map((x) => read(x, "E"));
  const neutralValue = neutral.trim() ? read(neutral, "NEUTRAL") : 0;
  const complete =
    dValue !== null && eValues.every((v): v is number => v !== null) && neutralValue !== null && eJudges.length > 0;

  let preview: string | null = null;
  if (complete) {
    const score = scorePerformance({
      d: toPoints(dValue),
      eDeductions: eValues.map((v) => toPoints(v!)),
      neutral: toPoints(neutralValue),
    });
    preview = `D ${fromPoints(score.d).toFixed(3)} + E ${fromPoints(score.e).toFixed(3)}${
      score.neutral > 0 ? ` − ${fromPoints(score.neutral).toFixed(3)}` : ""
    } = ${fromPoints(score.total).toFixed(3)}`;
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

  if (!dJudge || eJudges.length === 0) {
    return (
      <section className="tablet">
        <div className="alert">
          Секретариат ещё не завёл судей D и E этого снаряда. Их фамилии и оценки идут в протокол.
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
      />
    </label>
  );

  return (
    <section className="tablet">
      <h2>Оценки бригады</h2>
      <div className="tablet-grid">
        {field(`D · ${dJudge.name}`, d, setD, dValue !== null, true)}
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
  performances,
  gymnasts,
  rotation,
  onDone,
}: {
  token: string;
  competitionId: string;
  apparatus: string;
  performances: PerformanceView[];
  gymnasts: Map<string, Gymnast>;
  rotation: RotationView | null;
  onDone: () => Promise<void>;
}) {
  const [filter, setFilter] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Смены, которые в этой ротации стоят на снаряде, в порядке выхода.
  const shiftsHere = rotation?.shifts.filter((s) => s.apparatus === apparatus) ?? [];
  const byShift = rotation !== null && rotation.shifts.length > 0 && !showAll;

  const firstDone = new Set(performances.filter((p) => p.attempt === 1).map((p) => p.gymnastId));
  const secondDone = new Set(performances.filter((p) => p.attempt === 2).map((p) => p.gymnastId));
  const approvedFirst = new Set(
    performances.filter((p) => p.attempt === 1 && p.status === "APPROVED").map((p) => p.gymnastId),
  );
  const matches = (g: Gymnast) =>
    !filter || String(g.bib).startsWith(filter) || g.lastName.toLowerCase().startsWith(filter.toLowerCase());
  const everyone = byShift
    ? shiftsHere.flatMap((s) => s.gymnastIds.map((id) => gymnasts.get(id)).filter((g): g is Gymnast => Boolean(g)))
    : [...gymnasts.values()].sort((a, b) => a.bib - b.bib);
  const first = everyone.filter((g) => !firstDone.has(g.id) && matches(g));
  // Второй прыжок — по желанию (на финал в опорном прыжке), он не держит смену.
  const second =
    apparatus === "VT" ? everyone.filter((g) => approvedFirst.has(g.id) && !secondDone.has(g.id) && matches(g)) : [];

  let empty = "Все участники выступили на этом снаряде";
  if (filter) empty = "Никого не найдено";
  else if (byShift && shiftsHere.length === 0) empty = "В этой ротации на снаряде нет смены";
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

  return (
    <section className="call">
      {rotation && rotation.shifts.length > 0 && (
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
                className={byShift && i === 0 && !filter ? "next" : undefined}
                disabled={busy}
                onClick={() => void call(gymnast, 1)}
              >
                <strong>№{gymnast.bib}</strong> {gymnast.lastName} {gymnast.firstName}
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
