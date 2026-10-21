import { useEffect, useState } from "react";
import { io } from "socket.io-client";
import { LIVE_EVENTS } from "@ag/shared";

/** Подключение судьи к рассылке: при любом событии по снаряду вызывает onChange. */
export function useLive(token: string, onChange: () => void): boolean {
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const socket = io("/live", { auth: { token }, transports: ["websocket", "polling"] });
    socket.on("connect", () => {
      setConnected(true);
      onChange();
    });
    socket.on("disconnect", () => setConnected(false));
    for (const event of [
      LIVE_EVENTS.called,
      LIVE_EVENTS.approved,
      LIVE_EVENTS.reopened,
      LIVE_EVENTS.marksUpdated,
      LIVE_EVENTS.rotation,
      LIVE_EVENTS.finals,
    ]) {
      socket.on(event, onChange);
    }
    return () => {
      socket.close();
    };
  }, [token, onChange]);

  // Сокет замечает обрыв Wi-Fi не сразу, а браузер сообщает о нём мгновенно.
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    addEventListener("online", update);
    addEventListener("offline", update);
    return () => {
      removeEventListener("online", update);
      removeEventListener("offline", update);
    };
  }, []);
  return connected && online;
}

/**
 * Подписка секретариата на соревнование: при вызове, утверждении или возврате оценки на любом снаряде
 * вызывает onChange, чтобы списки обновлялись без перезагрузки страницы.
 */
export function useCompetitionLive(competitionId: string, enabled: boolean, onChange: () => void): void {
  useEffect(() => {
    if (!enabled) return;
    const socket = io("/live", { transports: ["websocket", "polling"] });
    socket.on("connect", () => {
      socket.emit(LIVE_EVENTS.join, { competitionId });
      onChange();
    });
    for (const event of [LIVE_EVENTS.called, LIVE_EVENTS.approved, LIVE_EVENTS.reopened, LIVE_EVENTS.rotation, LIVE_EVENTS.finals]) {
      socket.on(event, onChange);
    }
    return () => {
      socket.close();
    };
  }, [competitionId, enabled, onChange]);
}
