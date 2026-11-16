import { useEffect, useState } from "react";
import { io } from "socket.io-client";
import { LIVE_EVENTS, type BoardTimer } from "@ag/shared";

/** Таймер, пересчитанный на часы этого экрана: когда закончится по его часам. */
export interface LocalTimer {
  label: string;
  endsAt: number;
}

/** Сколько ещё показывать «Время!» после нуля. */
const AFTERGLOW_MS = 5000;

export function toLocal(timer: BoardTimer | null, now = Date.now()): LocalTimer | null {
  return timer ? { label: timer.label, endsAt: now + timer.remainingMs } : null;
}

/** «1:05», «0:09»; ноль и меньше — «0:00». */
export function formatLeft(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Таймер разминки или ротации, который запустил секретарь (только в зале). */
export function useBoardTimer(competitionId: string, enabled: boolean): { timer: LocalTimer | null; now: number } {
  const [timer, setTimer] = useState<LocalTimer | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return;
    const load = () =>
      fetch(`/competitions/${competitionId}/timer`)
        .then((r) => (r.ok ? (r.json() as Promise<{ timer: BoardTimer | null }>) : null))
        .then((body) => body && setTimer(toLocal(body.timer)))
        .catch(() => undefined);
    const socket = io("/live", { transports: ["websocket", "polling"] });
    socket.on("connect", () => {
      socket.emit(LIVE_EVENTS.join, { competitionId });
      void load();
    });
    socket.on(LIVE_EVENTS.timer, (t: BoardTimer | null) => setTimer(toLocal(t)));
    return () => {
      socket.close();
    };
  }, [competitionId, enabled]);

  useEffect(() => {
    if (!timer) return;
    const tick = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t - timer.endsAt > AFTERGLOW_MS) setTimer(null);
    }, 250);
    return () => clearInterval(tick);
  }, [timer]);

  return { timer, now };
}
