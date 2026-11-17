import { useCallback, useEffect, useRef, useState } from "react";
import { APPARATUS_NAMES, type ReplayView, type VideoStatus } from "@ag/shared";
import { apiRequest } from "./api";

/**
 * Видеоповторы: по одной IP-камере на снаряд, всё необязательно.
 * Нет камер — нет и кнопок «Повтор»: секретариат выглядит как раньше.
 */

/** Состояние камер; null — ещё не загрузили или нет доступа. */
export function useVideoStatus(adminToken: string | null, intervalMs = 30_000): [VideoStatus | null, () => Promise<void>] {
  const [status, setStatus] = useState<VideoStatus | null>(null);
  const load = useCallback(async () => {
    if (!adminToken) return;
    try {
      setStatus(await apiRequest<VideoStatus>("/video", { token: adminToken }));
    } catch {
      // Старый сервер без повторов или нет связи: кнопок повтора просто не будет.
    }
  }, [adminToken]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), intervalMs);
    return () => clearInterval(t);
  }, [load, intervalMs]);
  return [status, load];
}

export function hasCamera(video: VideoStatus | null, apparatus: string): boolean {
  return Boolean(video?.cameras.some((c) => c.apparatus === apparatus));
}

/** Кнопка «▶ Повтор» у выступления; без камеры на снаряде её нет. */
export function ReplayButton({
  performanceId,
  apparatus,
  title,
  adminToken,
  video,
}: {
  performanceId: string;
  apparatus: string;
  title: string;
  adminToken: string;
  video: VideoStatus | null;
}) {
  const [open, setOpen] = useState(false);
  if (!hasCamera(video, apparatus)) return null;
  return (
    <>
      <button type="button" className="replay-button" onClick={() => setOpen(true)} title="Видеоповтор выступления">
        ▶ Повтор
      </button>
      {open && <ReplayDialog performanceId={performanceId} title={title} adminToken={adminToken} onClose={() => setOpen(false)} />}
    </>
  );
}

const SPEEDS = [0.25, 0.5, 1] as const;

/** Проигрыватель повтора: замедление, покадровый шаг и ролик пошире. */
export function ReplayDialog({
  performanceId,
  title,
  adminToken,
  onClose,
}: {
  performanceId: string;
  title: string;
  adminToken: string;
  onClose: () => void;
}) {
  const [replay, setReplay] = useState<ReplayView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wide, setWide] = useState(false);
  const [busy, setBusy] = useState(false);
  const [speed, setSpeed] = useState(1);
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const r = await apiRequest<ReplayView>(`/performances/${performanceId}/replay`, { token: adminToken });
        if (stop) return;
        setReplay(r);
        setError(null);
        // Ролик нарезается через 10–20 секунд после оценки: ждём сами.
        if (r.status === "pending") timer = setTimeout(() => void load(), 3000);
      } catch (e) {
        if (!stop) setError((e as Error).message);
      }
    };
    void load();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [performanceId, adminToken]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (video.current) video.current.playbackRate = speed;
  }, [speed, wide, replay?.url]);

  const widen = async () => {
    setBusy(true);
    try {
      setReplay(await apiRequest<ReplayView>(`/performances/${performanceId}/replay/wide`, { token: adminToken, method: "POST" }));
      setWide(true);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const step = (seconds: number) => {
    const v = video.current;
    if (!v) return;
    v.pause();
    v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + seconds));
  };

  const src = wide && replay?.wideUrl ? replay.wideUrl : replay?.url;
  return (
    <div className="replay-backdrop" role="dialog" aria-modal="true" aria-label={`Повтор: ${title}`} onClick={onClose}>
      <div className="replay-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="replay-head">
          <strong>Повтор: {title}</strong>
          <button type="button" onClick={onClose} aria-label="Закрыть">
            ✕
          </button>
        </div>
        {error && <div className="alert">{error}</div>}
        {!replay && !error && <p className="muted">Загрузка…</p>}
        {replay && replay.status !== "ready" && <p className={replay.status === "pending" ? "muted" : "warning-text"}>{replay.message}</p>}
        {src && (
          <>
            <video key={src} ref={video} src={src} controls autoPlay muted playsInline onLoadedMetadata={(e) => (e.currentTarget.playbackRate = speed)} />
            <div className="replay-controls">
              <span className="muted">Скорость:</span>
              {SPEEDS.map((s) => (
                <button key={s} type="button" className={speed === s ? "primary" : undefined} onClick={() => setSpeed(s)}>
                  {s === 1 ? "1×" : `${s}×`}
                </button>
              ))}
              <button type="button" onClick={() => step(-0.1)} title="Назад на кадр">
                ◀ кадр
              </button>
              <button type="button" onClick={() => step(0.1)} title="Вперёд на кадр">
                кадр ▶
              </button>
              {!wide && (
                <button type="button" disabled={busy} onClick={() => void widen()} title="Ещё по 30 секунд до и после">
                  {busy ? "Нарезаем…" : "Шире ±30 с"}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const STATE_TEXT: Record<VideoStatus["cameras"][number]["state"], string> = {
  recording: "пишет",
  connecting: "подключается",
  error: "не пишет",
  stopped: "остановлена",
};

/** Сначала снаряды девочек, потом мальчиков; вольные и опорный прыжок общие. */
const HALL_ORDER = ["VT", "UB", "BB", "FX", "PH", "SR", "PB", "HB"] as const;

const gb = (bytes: number) => (bytes < 1024 ** 3 ? `${Math.round(bytes / 1024 ** 2)} МБ` : `${(bytes / 1024 ** 3).toFixed(1)} ГБ`);

/** Секретариат: адреса камер по снарядам, состояние записи, место на диске. */
export function VideoCamerasPanel({
  adminToken,
  competitionId,
  onError,
}: {
  adminToken: string;
  competitionId: string | null;
  onError: (m: string | null) => void;
}) {
  const [status, reload] = useVideoStatus(adminToken, 5000);
  const [urls, setUrls] = useState<Record<string, string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [snapshot, setSnapshot] = useState<{ apparatus: string; src: string } | null>(null);
  const [clips, setClips] = useState<{ count: number; bytes: number } | null>(null);

  // Поля заполняются один раз с сервера, дальше их правит секретарь.
  useEffect(() => {
    if (status && urls === null) setUrls(Object.fromEntries(status.cameras.map((c) => [c.apparatus, c.url])));
  }, [status, urls]);

  const loadClips = useCallback(async () => {
    if (!competitionId) return setClips(null);
    try {
      setClips(await apiRequest<{ count: number; bytes: number }>(`/competitions/${competitionId}/replays`, { token: adminToken }));
    } catch {
      setClips(null);
    }
  }, [competitionId, adminToken]);
  useEffect(() => {
    void loadClips();
  }, [loadClips]);

  const save = async () => {
    setBusy(true);
    try {
      const cameras = Object.entries(urls ?? {})
        .map(([apparatus, url]) => ({ apparatus, url: url.trim() }))
        .filter((c) => c.url);
      await apiRequest("/video/cameras", { token: adminToken, method: "PUT", body: { cameras } });
      setUrls(null);
      await reload();
      setSaved(true);
      onError(null);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const showFrame = async (apparatus: string) => {
    try {
      const res = await fetch(`/video/cameras/${apparatus}/snapshot`, { headers: { Authorization: `Bearer ${adminToken}` } });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `Ошибка сервера ${res.status}`);
      }
      const blob = await res.blob();
      const src = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("Не удалось показать кадр"));
        reader.readAsDataURL(blob);
      });
      setSnapshot({ apparatus, src });
      onError(null);
    } catch (e) {
      onError((e as Error).message);
    }
  };

  // Архив может быть большим: браузер скачивает его сам по ссылке, показывая ход загрузки.
  const downloadClips = async () => {
    if (!competitionId) return;
    try {
      const { url } = await apiRequest<{ url: string }>(`/competitions/${competitionId}/replays/archive-link`, { token: adminToken });
      window.location.href = url;
      onError(null);
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const removeClips = async () => {
    if (!competitionId || !clips?.count) return;
    if (!window.confirm(`Удалить ${clips.count} роликов этого турнира? Посмотреть их потом будет нельзя.`)) return;
    try {
      await apiRequest(`/competitions/${competitionId}/replays`, { token: adminToken, method: "DELETE" });
      await loadClips();
      await reload();
      onError(null);
    } catch (e) {
      onError((e as Error).message);
    }
  };

  if (!status) return <p className="muted wide">Загрузка…</p>;
  return (
    <section className="panel no-print video-panel">
      <p className="muted wide">
        Камеры необязательны: без них программа работает как обычно, а камеры можно поставить только на часть снарядов.
        Впишите адрес видеопотока камеры (обычно <code>rtsp://логин:пароль@192.168.…:554/…</code>, он есть в инструкции к камере) и нажмите
        «Сохранить». Сервер пишет камеру и после каждой утверждённой оценки сам нарезает ролик выступления: от вызова участника до
        первой оценки судьи. Ролик смотрят кнопкой «▶ Повтор» на вкладке «Главный судья» и у запросов тренеров.
      </p>
      {!status.available && <div className="alert wide">{status.reason}</div>}
      {status.available && (
        <>
          <table className="wide video-cameras">
            <tbody>
              {HALL_ORDER.map((a) => {
                const cam = status.cameras.find((c) => c.apparatus === a);
                return (
                  <tr key={a}>
                    <td>{APPARATUS_NAMES[a]}</td>
                    <td>
                      <input
                        value={urls?.[a] ?? ""}
                        placeholder="нет камеры"
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(e) => {
                          setSaved(false);
                          setUrls({ ...(urls ?? {}), [a]: e.target.value });
                        }}
                      />
                    </td>
                    <td>
                      {cam && (
                        <span className={`video-state video-${cam.state}`} title={cam.message ?? undefined}>
                          {STATE_TEXT[cam.state]}
                          {cam.message && cam.state !== "recording" ? `: ${cam.message}` : ""}
                        </span>
                      )}
                    </td>
                    <td>
                      {cam && (
                        <button type="button" onClick={() => void showFrame(a)}>
                          Кадр
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="wide">
            <button type="button" className={saved ? "primary saved" : "primary"} disabled={busy} onClick={() => void save()}>
              {saved ? "Сохранено" : "Сохранить"}
            </button>
          </div>
          {snapshot && (
            <figure className="wide video-snapshot">
              <img src={snapshot.src} alt={`Кадр с камеры: ${APPARATUS_NAMES[snapshot.apparatus]}`} />
              <figcaption className="muted">
                Кадр с камеры «{APPARATUS_NAMES[snapshot.apparatus]}». Снаряд должен быть виден целиком.{" "}
                <button type="button" className="link" onClick={() => setSnapshot(null)}>
                  Скрыть
                </button>
              </figcaption>
            </figure>
          )}
          <p className="muted wide">
            {status.disk && (
              <>
                Свободно на диске: <strong>{gb(status.disk.freeBytes)}</strong> из {gb(status.disk.totalBytes)}, видео занимает{" "}
                {gb(status.disk.videoBytes)}.{" "}
              </>
            )}
            Непрерывная запись хранится {status.keepHours} ч, ролики — {status.clipDays} дн., потом удаляются сами. Если свободно меньше{" "}
            {status.minFreeGb} ГБ, сначала удаляется старая запись, а потом запись останавливается; судейство идёт как обычно.
          </p>
          {clips && clips.count > 0 && (
            <div className="wide deduction-row">
              <span>
                Роликов у этого турнира: {clips.count} ({gb(clips.bytes)}). В архиве они названы понятно: «Бревно №11 Иванова Анна».
              </span>
              <button type="button" onClick={() => void downloadClips()}>
                Скачать ролики турнира одним архивом
              </button>
              <button type="button" className="link danger" onClick={() => void removeClips()}>
                Удалить ролики турнира
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
