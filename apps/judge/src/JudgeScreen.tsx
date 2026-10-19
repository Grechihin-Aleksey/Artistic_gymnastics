import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { fromPoints, scorePerformance, toPoints } from "@ag/scoring";
import type { JudgeRole, MarkKind, PerformanceView, SubmitMarkInput } from "@ag/shared";
import { ApiError, apiRequest } from "./api";
import { Keypad } from "./Keypad";
import { APPARATUS_NAMES, KIND_NAMES, KINDS_BY_ROLE, ROLE_NAMES, judgeLabel, parseScore } from "./labels";
import { MarkQueue, type Rejected, type SendOutcome } from "./markQueue";
import { useLive } from "./useLive";
import { uuid } from "./uuid";

interface Me {
  judge: { id: string; name: string; apparatus: string; role: JudgeRole; seat: number; competitionId: string };
  competition: { id: string; name: string; discipline: string };
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
      const [list, people] = await Promise.all([
        apiRequest<PerformanceView[]>(`/competitions/${competition.id}/performances?apparatus=${judge.apparatus}`, {
          token,
        }),
        apiRequest<Gymnast[]>(`/competitions/${competition.id}/gymnasts`),
      ]);
      setPerformances(list);
      setGymnasts(new Map(people.map((g) => [g.id, g])));
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
        </main>
      ) : (
        <main className="waiting">
          <p>Ожидаем вызова участника</p>
          {lastApproved?.score && (
            <p className="muted">
              Последний итог: {gymnasts.get(lastApproved.gymnastId)?.lastName ?? ""} —{" "}
              <strong>{lastApproved.score.total.toFixed(3)}</strong>
            </p>
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
