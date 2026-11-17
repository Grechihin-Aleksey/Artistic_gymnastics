import { useCallback, useEffect, useState } from "react";
import type { Discipline } from "@ag/scoring";
import type { Rules } from "@ag/shared";
import { ApiError, apiRequest } from "./api";
import { ChiefJudgePanel } from "./ChiefJudge";
import { useKeepAwake } from "./keepAwake";
import { InquiriesPanel } from "./Secretariat";

const KEY = "chief-token";
const PART_NAMES: Record<string, string> = { WAG: "Девочки", MAG: "Мальчики" };

interface ChiefCompetition {
  id: string;
  name: string;
  discipline: Discipline;
  rules: Rules;
}
interface ChiefMe {
  competitionId: string;
  competitions: ChiefCompetition[];
}

/** Код главного судьи приходит в адресе из QR-кода (#chief=…): сохраняем его и убираем из адреса. */
export function takeChiefToken(location: Location, storage: Storage): string | null {
  const match = /(?:^#|&)chief=([^&]+)/.exec(location.hash);
  if (match?.[1]) {
    const token = decodeURIComponent(match[1]);
    try {
      storage.setItem(KEY, token);
    } catch {
      // приватный режим: код живёт только в этой вкладке
    }
    history.replaceState(null, "", `${location.pathname}${location.search}#/chief`);
    return token;
  }
  try {
    return storage.getItem(KEY);
  } catch {
    return null;
  }
}

function forget() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // нечего удалять
  }
}

/**
 * Экран главного судьи на отдельном ПК или планшете: все снаряды сразу, «Что проверить»
 * и запросы тренеров с решениями жюри. Турнир он не правит — это делает секретариат.
 */
export function ChiefScreen() {
  const [token, setToken] = useState(() => takeChiefToken(location, localStorage));
  const [me, setMe] = useState<ChiefMe | null>(null);
  const [partId, setPartId] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const onError = useCallback((m: string | null) => setError(m), []);
  useKeepAwake();

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      apiRequest<ChiefMe>("/chief/me", { token })
        .then((data) => {
          if (cancelled) return;
          setMe(data);
          setProblem(null);
          setPartId((id) => (data.competitions.some((c) => c.id === id) ? id : data.competitionId));
        })
        .catch((e: ApiError) => {
          if (cancelled) return;
          if (e.status === 401 || e.status === 403) {
            forget();
            setToken(null);
            setProblem("Код главного судьи больше не действует. Попросите в секретариате новый QR-код.");
          } else {
            setProblem(e.message);
            retry = setTimeout(load, 3000);
          }
        });
    load();
    return () => {
      cancelled = true;
      clearTimeout(retry);
    };
  }, [token]);

  if (!token) {
    return (
      <div className="screen waiting">
        <h1>Главный судья</h1>
        <p>Отсканируйте QR-код главного судьи, который выдал секретариат (экран «Судьи»).</p>
        {problem && <div className="alert">{problem}</div>}
      </div>
    );
  }
  if (!me) return <div className="screen waiting">{problem ?? "Подключаемся к серверу…"}</div>;

  const part = me.competitions.find((c) => c.id === partId) ?? me.competitions[0]!;
  const parts = [...me.competitions].sort((a, b) => (a.discipline === "WAG" ? -1 : b.discipline === "WAG" ? 1 : 0));
  return (
    <div className="screen admin chief-screen">
      <header className="bar no-print">
        <div className="apparatus">Главный судья</div>
        <div className="chief-title">{part.name}</div>
        <button
          type="button"
          className="link"
          onClick={() => {
            if (!confirm("Выйти? Для входа снова понадобится QR-код главного судьи.")) return;
            forget();
            setToken(null);
            setMe(null);
          }}
        >
          Выйти
        </button>
      </header>
      {parts.length > 1 && (
        <div className="part-switch no-print" role="group" aria-label="Часть турнира">
          {parts.map((c) => (
            <button
              key={c.id}
              type="button"
              className={c.id === part.id ? "active" : undefined}
              aria-pressed={c.id === part.id}
              onClick={() => setPartId(c.id)}
            >
              {PART_NAMES[c.discipline] ?? c.name}
            </button>
          ))}
        </div>
      )}
      {error && <div className="alert no-print">{error}</div>}
      <ChiefJudgePanel key={`chief-${part.id}`} competitionId={part.id} discipline={part.discipline} adminToken={token} onError={onError} active />
      <InquiriesPanel key={`inq-${part.id}`} competitionId={part.id} discipline={part.discipline} adminToken={token} onError={onError} rules={part.rules} />
    </div>
  );
}
