import { useCallback, useEffect, useState } from "react";
import { CLEANUP_KEEP_DUMPS, type CleanupStatus } from "@ag/shared";
import { apiRequest } from "./api";

const mb = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} ГБ` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} МБ`);
const day = (iso: string) => new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });

/** Очистка после турниров: лишние копии базы удаляются через заданный срок после последнего изменения. */
export function CleanupPanel({ adminToken, onError }: { adminToken: string; onError: (m: string | null) => void }) {
  const [status, setStatus] = useState<CleanupStatus | null>(null);
  const [days, setDays] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await apiRequest<CleanupStatus>("/cleanup", { token: adminToken });
      setStatus(s);
      setDays(String(s.days));
    } catch (e) {
      onError((e as Error).message);
    }
  }, [adminToken, onError]);
  useEffect(() => void load(), [load]);

  const run = async (action: () => Promise<CleanupStatus>) => {
    setBusy(true);
    try {
      setStatus(await action());
      onError(null);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    run(async () => {
      const s = await apiRequest<CleanupStatus>("/cleanup", { token: adminToken, method: "PUT", body: { days: Number(days) } });
      setDays(String(s.days));
      return s;
    });
  const clean = () => run(() => apiRequest<CleanupStatus>("/cleanup/run", { token: adminToken, method: "POST" }));

  if (!status) return null;
  return (
    <section className="panel no-print">
      <p className="muted wide">
        Во время турнира копия базы снимается каждые 5 минут, и за день набирается до 288 файлов. Когда в программе ничего не
        меняется, новые копии не снимаются. Через заданный срок после последнего изменения лишние копии удаляются сами;{" "}
        {CLEANUP_KEEP_DUMPS} самых свежих остаются всегда, и в них все турниры целиком. Турниры, протоколы, результаты и файлы
        турниров не удаляются никогда.
      </p>
      {!status.enabled ? (
        <p className="wide">Папка резервных копий не подключена: программа запущена не через «Запуск».</p>
      ) : (
        <>
          <p className="wide">
            Копий базы: <strong>{status.dumps.count}</strong> ({mb(status.dumps.bytes)})
            {status.lastChangeAt && <> · последнее изменение в программе: {day(status.lastChangeAt)}</>}
            <br />
            {status.removable.count === 0
              ? "Удалять нечего."
              : status.dueAt
                ? `Лишние копии (${status.removable.count}, ${mb(status.removable.bytes)}) удалятся ${day(status.dueAt)}, если до этого в программе ничего не изменится.`
                : `Лишних копий ${status.removable.count} (${mb(status.removable.bytes)}), автоудаление выключено.`}
          </p>
          {status.lastRun && (
            <p className="wide muted">
              {status.lastRun.auto ? "Автоочистка" : "Очистка"} {day(status.lastRun.at)}: удалено копий {status.lastRun.deleted},
              освобождено {mb(status.lastRun.freedBytes)}.
            </p>
          )}
          <form
            className="wide cleanup-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label>
              Удалять лишние копии через, дней (0 — не удалять)
              <input type="number" min={0} max={3650} value={days} onChange={(e) => setDays(e.target.value)} />
            </label>
            <button type="submit" disabled={busy || days === String(status.days) || days === ""}>
              Сохранить срок
            </button>
            <button type="button" disabled={busy || status.removable.count === 0} onClick={() => void clean()}>
              Очистить сейчас
            </button>
          </form>
        </>
      )}
    </section>
  );
}
