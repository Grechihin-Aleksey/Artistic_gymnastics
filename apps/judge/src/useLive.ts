import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import { LIVE_EVENTS } from "@ag/shared";
import { LiveLink, type LinkState } from "./liveLink";

export interface LiveStatus {
  /** Планшет на связи и подписан на свою бригаду. */
  connected: boolean;
  /** Связи нет, планшет сам пытается подключиться. */
  reconnecting: boolean;
  /** Подключиться заново прямо сейчас. */
  reconnectNow: () => void;
}

/**
 * Подключение судьи к рассылке: при любом событии по снаряду вызывает onChange.
 * Связь восстанавливается сама, когда судья с планшетом возвращается в зал (см. LiveLink);
 * после переподключения onChange вызывается снова, и планшет досылает неотправленные оценки.
 * onRejected — код входа больше не действует.
 */
export function useLive(
  token: string,
  competitionId: string,
  handlers: { onChange: () => void; onRecovery?: () => void; onRejected?: () => void },
): LiveStatus & { allowAgain: () => void } {
  const [state, setState] = useState<LinkState>("connecting");
  // Обработчики меняются при каждой отрисовке; подключение из-за этого переоткрывать не нужно.
  const latest = useRef(handlers);
  latest.current = handlers;
  const link = useRef<LiveLink | null>(null);

  useEffect(() => {
    const socket = io("/live", {
      auth: { token },
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 5_000,
    });
    const onChange = () => latest.current.onChange();
    const live = new LiveLink(socket, competitionId, {
      onReady: onChange,
      onRejected: () => latest.current.onRejected?.(),
    });
    link.current = live;
    setState(live.current());
    const unsubscribe = live.subscribe(setState);
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
    socket.on(LIVE_EVENTS.recoveryRequested, () => latest.current.onRecovery?.());
    return () => {
      unsubscribe();
      live.stop();
      link.current = null;
      socket.close();
    };
  }, [token, competitionId]);

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
  const connected = state === "ready" && online;
  return {
    connected,
    reconnecting: !connected && state !== "rejected",
    reconnectNow: () => link.current?.reconnectNow(true),
    allowAgain: () => link.current?.allowAgain(),
  };
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
