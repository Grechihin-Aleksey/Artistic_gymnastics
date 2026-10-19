import { useCallback, useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import { LIVE_EVENTS, RELAY_EVENTS, type BoardSnapshot, type PerformanceView } from "@ag/shared";
import { isRelay } from "./route";

export type BoardData = BoardSnapshot;

interface BoardState {
  data: BoardData | null;
  connected: boolean;
  error: string | null;
}

/**
 * Данные табло. В зале — с сервера соревнований по событиям Socket.IO
 * (и на всякий случай раз в 30 секунд), на сайте — потоком от ретранслятора.
 * onApproved получает каждую новую утверждённую оценку для всплывающей строки.
 */
export function useBoard(competitionId: string, onApproved: (p: PerformanceView) => void): BoardState {
  const approvedRef = useRef(onApproved);
  approvedRef.current = onApproved;
  const approved = useCallback((p: PerformanceView) => approvedRef.current(p), []);
  return isRelay(location.pathname) ? useRelayBoard(competitionId, approved) : useHallBoard(competitionId, approved);
}

function useHallBoard(competitionId: string, onApproved: (p: PerformanceView) => void): BoardState {
  const [data, setData] = useState<BoardData | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(() => {
    const path = `/competitions/${competitionId}/results/snapshot`;
    fetch(path)
      .then(async (response) => {
        if (!response.ok) throw new Error(`${path}: ${response.status}`);
        setData((await response.json()) as BoardData);
        setError(null);
      })
      .catch((e: Error) => setError(`Нет связи с сервером: ${e.message}`));
  }, [competitionId]);

  // Несколько событий подряд (вызов, оценка) — одно обновление.
  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(refresh, 300);
  }, [refresh]);

  useEffect(() => {
    refresh();
    const poll = setInterval(refresh, 30_000);
    const socket = io("/live", { transports: ["websocket", "polling"] });
    socket.on("connect", () => {
      setConnected(true);
      socket.emit(LIVE_EVENTS.join, { competitionId });
      schedule();
    });
    socket.on("disconnect", () => setConnected(false));
    socket.on(LIVE_EVENTS.called, schedule);
    socket.on(LIVE_EVENTS.reopened, schedule);
    socket.on(LIVE_EVENTS.approved, (p: PerformanceView) => {
      onApproved(p);
      schedule();
    });
    return () => {
      clearInterval(poll);
      if (timer.current) clearTimeout(timer.current);
      socket.close();
    };
  }, [competitionId, refresh, schedule, onApproved]);

  return { data, connected, error };
}

function useRelayBoard(competitionId: string, onApproved: (p: PerformanceView) => void): BoardState {
  const [data, setData] = useState<BoardData | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Адрес относительный: ретранслятор может стоять не в корне сайта.
    const events = new EventSource(`../api/competitions/${encodeURIComponent(competitionId)}/events`);
    events.onopen = () => {
      setConnected(true);
      setError(null);
    };
    // Браузер сам переподключается и получает свежий снимок.
    events.onerror = () => setConnected(false);
    events.addEventListener(RELAY_EVENTS.snapshot, (e) => setData(JSON.parse(e.data) as BoardData));
    events.addEventListener(RELAY_EVENTS.approved, (e) => onApproved(JSON.parse(e.data) as PerformanceView));
    // Если зал ещё ничего не прислал, через пару секунд говорим об этом.
    const empty = setTimeout(() => setError("Результаты появятся, когда начнутся выступления"), 3000);
    return () => {
      clearTimeout(empty);
      events.close();
    };
  }, [competitionId, onApproved]);

  return { data, connected, error };
}
