import { useCallback, useEffect, useState } from "react";
import type { UpdateStatus } from "@ag/shared";
import { apiRequest } from "./api";

const DISMISSED_KEY = "update-dismissed";

function dismissedVersion(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

/** Опрос сервера раз в 30 минут: сам сервер ходит в интернет раз в 6 часов. */
function useUpdateStatus(adminToken: string) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const load = useCallback(
    (check = false) =>
      apiRequest<UpdateStatus>(check ? "/updates/check" : "/updates", { token: adminToken, method: check ? "POST" : "GET" })
        .then(setStatus)
        .catch(() => undefined),
    [adminToken],
  );
  useEffect(() => {
    if (!adminToken) return;
    void load();
    const timer = setInterval(() => void load(), 30 * 60_000);
    return () => clearInterval(timer);
  }, [adminToken, load]);
  return { status, load };
}

/**
 * Сообщение секретариату, что вышла новая версия программы. Обновляет «Обновить.bat»
 * на ноутбуке сервера; в день соревнований обновляться не советуем — это видно из текста.
 * «Скрыть» прячет сообщение до следующей версии.
 */
export function UpdateNotice({ adminToken }: { adminToken: string }) {
  const { status } = useUpdateStatus(adminToken);
  const [dismissed, setDismissed] = useState(dismissedVersion);
  if (!status?.available || !status.latest || dismissed === status.latest) return null;
  const latest = status.latest;
  return (
    <div className="notice update-notice no-print" role="status">
      <strong>Вышла новая версия программы {latest}</strong> (у вас {status.current}).
      {status.notes.length > 0 && (
        <ul>
          {status.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      <div>
        Обновитесь после турнира, не во время соревнований: на ноутбуке сервера дважды щёлкните «Обновить.bat». Турниры и настройки
        сохранятся.
      </div>
      <button
        type="button"
        onClick={() => {
          try {
            localStorage.setItem(DISMISSED_KEY, latest);
          } catch {
            // Не сохранилось — скроется до перезагрузки страницы.
          }
          setDismissed(latest);
        }}
      >
        Скрыть до следующей версии
      </button>
    </div>
  );
}

/** Строка с версией в блоке «Соревнование»: какая стоит и когда проверяли. */
export function VersionLine({ adminToken }: { adminToken: string }) {
  const { status, load } = useUpdateStatus(adminToken);
  const [busy, setBusy] = useState(false);
  if (!status) return null;
  const checked = status.checkedAt
    ? new Date(status.checkedAt).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })
    : null;
  return (
    <p className="muted version-line no-print">
      Версия программы {status.current}.{" "}
      {status.available
        ? `Доступна новая: ${status.latest}.`
        : checked
          ? `Это последняя версия (проверено ${checked}).`
          : "Проверить новую версию пока не удалось: нужен интернет на ноутбуке сервера."}{" "}
      <button
        type="button"
        className="link"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void load(true).finally(() => setBusy(false));
        }}
      >
        {busy ? "Проверяем…" : "Проверить сейчас"}
      </button>
    </p>
  );
}
