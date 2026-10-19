import { useCallback, useEffect, useState } from "react";
import { apparatusFor, type Discipline } from "@ag/scoring";
import type { InquiryView, PerformanceView } from "@ag/shared";
import { ApiError, apiRequest } from "./api";
import { APPARATUS_NAMES, parseScore } from "./labels";

interface Gymnast {
  id: string;
  bib: number;
  firstName: string;
  lastName: string;
}

interface Props {
  competitionId: string;
  discipline: Discipline;
  adminToken: string;
  onError: (message: string | null) => void;
}

const fmt = (n: number) => n.toFixed(3);

/** Протоколы в PDF: открываются в новой вкладке, оттуда их печатают или сохраняют. */
export function ProtocolsPanel({ competitionId, discipline, adminToken, onError }: Props) {
  const open = async (path: string, filename: string) => {
    // Окно открываем сразу по нажатию, иначе браузер сочтёт его всплывающей рекламой.
    const tab = window.open("", "_blank");
    try {
      const response = await fetch(`/competitions/${competitionId}/protocols/${path}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new ApiError(response.status, data?.message ?? `Ошибка сервера ${response.status}`);
      }
      const url = URL.createObjectURL(await response.blob());
      if (tab) tab.location.href = url;
      else {
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        link.click();
      }
      onError(null);
    } catch (e) {
      tab?.close();
      onError(e instanceof ApiError && e.status !== 0 ? e.message : "Нет связи с сервером");
    }
  };

  return (
    <section className="panel protocols no-print">
      <h2>Протоколы</h2>
      <div className="buttons">
        {apparatusFor(discipline).map((a) => (
          <button key={a} type="button" onClick={() => void open(`apparatus/${a}`, `protocol-${a}.pdf`)}>
            {APPARATUS_NAMES[a]}
          </button>
        ))}
        <button type="button" onClick={() => void open("all-around", "protocol-all-around.pdf")}>
          Многоборье
        </button>
        <button type="button" onClick={() => void open("teams", "protocol-teams.pdf")}>
          Команды
        </button>
      </div>
    </section>
  );
}

const STATUS_NAMES = { PENDING: "Ждёт решения", ACCEPTED: "Удовлетворён", REJECTED: "Отклонён" } as const;

/**
 * Запросы тренеров на пересмотр оценки D. Секретариат записывает запрос
 * и вносит решение апелляционного жюри; новая оценка сразу уходит на табло и сайт.
 */
export function InquiriesPanel({ competitionId, discipline, adminToken, onError }: Props) {
  const [apparatus, setApparatus] = useState<string>(apparatusFor(discipline)[0]!);
  const [performances, setPerformances] = useState<PerformanceView[]>([]);
  const [gymnasts, setGymnasts] = useState<Map<string, Gymnast>>(new Map());
  const [inquiries, setInquiries] = useState<InquiryView[]>([]);

  const load = useCallback(async () => {
    try {
      const [perfs, people, list] = await Promise.all([
        apiRequest<PerformanceView[]>(`/competitions/${competitionId}/performances?apparatus=${apparatus}`, {
          token: adminToken,
        }),
        apiRequest<Gymnast[]>(`/competitions/${competitionId}/gymnasts`),
        apiRequest<InquiryView[]>(`/competitions/${competitionId}/inquiries`, { token: adminToken }),
      ]);
      // Свежие оценки сверху: запрос обычно подают на только что показанную.
      setPerformances(perfs.filter((p) => p.status === "APPROVED").reverse());
      setGymnasts(new Map(people.map((g) => [g.id, g])));
      setInquiries([...list].reverse());
    } catch (e) {
      onError((e as Error).message);
    }
  }, [competitionId, apparatus, adminToken, onError]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  const submit = async (form: FormData) => {
    const claimed = String(form.get("claimedD") ?? "").replace(",", ".").trim();
    const claimedD = claimed ? parseScore(claimed, "D") : undefined;
    if (claimedD === null) return onError("Оценка D: число до 20 с точностью до тысячных, например 5.400");
    try {
      await apiRequest(`/performances/${String(form.get("performanceId"))}/inquiries`, {
        token: adminToken,
        method: "POST",
        body: { coach: String(form.get("coach")), ...(claimedD !== undefined ? { claimedD } : {}) },
      });
      onError(null);
      await load();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const resolve = async (inquiry: InquiryView, accept: boolean) => {
    let body: object = { decision: "reject" };
    if (accept) {
      const input = prompt(
        `Новая оценка D для №${inquiry.gymnast.bib} ${inquiry.gymnast.lastName} (сейчас ${fmt(inquiry.previousD)})`,
        inquiry.claimedD !== null ? fmt(inquiry.claimedD) : "",
      );
      if (input === null) return;
      const d = parseScore(input.replace(",", ".").trim(), "D");
      if (d === null) return onError("Оценка D: число до 20 с точностью до тысячных, например 5.400");
      body = { decision: "accept", d };
    } else if (!confirm(`Отклонить запрос по №${inquiry.gymnast.bib} ${inquiry.gymnast.lastName}? Оценка останется ${fmt(inquiry.previousD)}.`)) {
      return;
    }
    try {
      await apiRequest(`/inquiries/${inquiry.id}/resolve`, { token: adminToken, method: "POST", body });
      onError(null);
      await load();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const name = (gymnastId: string) => {
    const g = gymnasts.get(gymnastId);
    return g ? `№${g.bib} ${g.lastName} ${g.firstName}` : "—";
  };

  return (
    <section className="inquiries no-print">
      <form
        className="panel"
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          void submit(new FormData(form)).then(() => form.reset());
        }}
      >
        <h2>Запрос на пересмотр D</h2>
        <label>
          Снаряд
          <select value={apparatus} onChange={(e) => setApparatus(e.target.value)}>
            {apparatusFor(discipline).map((a) => (
              <option key={a} value={a}>
                {APPARATUS_NAMES[a]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Выступление
          <select name="performanceId" required>
            {performances.length === 0 && <option value="">Утверждённых оценок нет</option>}
            {performances.map((p) => (
              <option key={p.id} value={p.id}>
                {name(p.gymnastId)}
                {p.attempt > 1 ? `, прыжок ${p.attempt}` : ""} — D {fmt(p.score!.d)}, итог {fmt(p.score!.total)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Тренер
          <input name="coach" required />
        </label>
        <label>
          D по мнению тренера
          <input name="claimedD" inputMode="decimal" placeholder="необязательно" />
        </label>
        <button type="submit" className="primary" disabled={performances.length === 0}>
          Записать запрос
        </button>
      </form>

      {inquiries.length > 0 && (
        <table className="panel">
          <tbody>
            {inquiries.map((q) => (
              <tr key={q.id} className={q.status === "PENDING" ? "pending" : ""}>
                <td>{APPARATUS_NAMES[q.apparatus]}</td>
                <td>
                  №{q.gymnast.bib} {q.gymnast.lastName} {q.gymnast.firstName}
                  {q.attempt > 1 ? `, прыжок ${q.attempt}` : ""}
                  <div className="muted">
                    {q.coach}, {new Date(q.createdAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}
                    {q.late && <span className="late"> · подан после срока</span>}
                  </div>
                </td>
                <td>
                  D {fmt(q.previousD)}
                  {q.claimedD !== null && <div className="muted">просят {fmt(q.claimedD)}</div>}
                </td>
                <td>
                  {STATUS_NAMES[q.status]}
                  {q.newD !== null && q.newD !== q.previousD && <div className="muted">новая D {fmt(q.newD)}</div>}
                  {q.note && <div className="muted">{q.note}</div>}
                </td>
                <td className="actions">
                  {q.status === "PENDING" && (
                    <>
                      <button type="button" className="primary" onClick={() => void resolve(q, true)}>
                        Удовлетворить
                      </button>
                      <button type="button" onClick={() => void resolve(q, false)}>
                        Отклонить
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
