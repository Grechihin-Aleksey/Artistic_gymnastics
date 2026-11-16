import { useState } from "react";
import { APPARATUS_NAMES, type GymnastView, type LiveApparatus } from "@ag/shared";

type Apparatus = LiveApparatus["apparatus"];

const COACH_KEY = "coach-name";

function savedCoach(): string {
  try {
    return localStorage.getItem(COACH_KEY) ?? "";
  } catch {
    return "";
  }
}

/** «5,4» и «5.4» — одно и то же; пусто — тренер не указал свою оценку. */
export function parseClaimed(text: string): number | null | undefined {
  const t = text.replace(",", ".").trim();
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 && n <= 20 ? Math.round(n * 1000) / 1000 : null;
}

/**
 * Запрос на пересмотр D со страницы «Мой клуб». Работает только на табло в сети зала:
 * запрос сразу появляется у секретариата и у главного судьи. Подать можно в срок —
 * до показа оценки следующего участника на снаряде и не позже 4 минут.
 */
export function CoachInquiry({
  competitionId,
  gymnast,
  apparatus,
  dLabel,
}: {
  competitionId: string;
  gymnast: GymnastView;
  apparatus: Apparatus[];
  dLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  if (!open) {
    return (
      <button type="button" className="coach-inquiry-open" onClick={() => (setOpen(true), setResult(null))}>
        Запрос на пересмотр {dLabel}
      </button>
    );
  }

  const submit = async (form: FormData) => {
    const coach = String(form.get("coach") ?? "").trim();
    const claimed = parseClaimed(String(form.get("claimedD") ?? ""));
    if (!coach) return setResult({ ok: false, text: "Укажите фамилию тренера" });
    if (claimed === null) return setResult({ ok: false, text: `${dLabel}: число до 20, например 5,4` });
    try {
      localStorage.setItem(COACH_KEY, coach);
    } catch {
      // Без сохранения имени тоже работает.
    }
    setBusy(true);
    try {
      const res = await fetch(`/competitions/${encodeURIComponent(competitionId)}/coach-inquiries`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gymnastId: gymnast.id,
          apparatus: form.get("apparatus"),
          coach,
          ...(claimed !== undefined ? { claimedD: claimed } : {}),
        }),
      });
      if (res.ok) {
        setResult({ ok: true, text: "Запрос принят. Секретариат передаст его жюри, решение появится на табло." });
      } else {
        const body = (await res.json().catch(() => null)) as { message?: string | string[] } | null;
        const message = Array.isArray(body?.message) ? body.message.join(", ") : body?.message;
        setResult({ ok: false, text: message ?? "Не удалось подать запрос. Обратитесь в секретариат." });
      }
    } catch {
      setResult({ ok: false, text: "Нет связи с сервером зала. Обратитесь в секретариат." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="coach-inquiry"
      onSubmit={(e) => {
        e.preventDefault();
        void submit(new FormData(e.currentTarget));
      }}
    >
      <strong>Запрос на пересмотр {dLabel}</strong>
      <label>
        Снаряд
        <select name="apparatus" defaultValue={apparatus[apparatus.length - 1]}>
          {apparatus.map((a) => (
            <option key={a} value={a}>
              {APPARATUS_NAMES[a]}
            </option>
          ))}
        </select>
      </label>
      <label>
        Тренер
        <input name="coach" defaultValue={savedCoach()} autoComplete="name" required />
      </label>
      <label>
        {dLabel} по мнению тренера
        <input name="claimedD" inputMode="decimal" placeholder="необязательно" />
      </label>
      <p className="muted">Подаётся до показа оценки следующего участника на снаряде, не позже 4 минут.</p>
      {result && <p className={result.ok ? "coach-inquiry-ok" : "coach-inquiry-error"}>{result.text}</p>}
      <div className="coach-inquiry-actions">
        {!result?.ok && (
          <button type="submit" disabled={busy}>
            {busy ? "Отправляем…" : "Подать запрос"}
          </button>
        )}
        <button type="button" onClick={() => setOpen(false)}>
          {result?.ok ? "Готово" : "Отмена"}
        </button>
      </div>
    </form>
  );
}
