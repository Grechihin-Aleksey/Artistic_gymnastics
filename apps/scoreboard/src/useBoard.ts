import { useCallback, useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import {
  LIVE_EVENTS,
  type AllAroundRow,
  type ApparatusResultRow,
  type LiveApparatus,
  type PerformanceView,
  type TeamResultRow,
} from "@ag/shared";

export interface Competition {
  id: string;
  name: string;
  discipline: "MAG" | "WAG";
}

export interface BoardData {
  competition: Competition;
  live: LiveApparatus[];
  allAround: AllAroundRow[];
  teams: TeamResultRow[];
  apparatus: Record<string, ApparatusResultRow[]>;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return (await response.json()) as T;
}

async function load(competitionId: string): Promise<BoardData> {
  const base = `/competitions/${competitionId}`;
  const competition = await getJson<Competition>(base);
  const [live, allAround, teams] = await Promise.all([
    getJson<LiveApparatus[]>(`${base}/results/live`),
    getJson<AllAroundRow[]>(`${base}/results/all-around`),
    // Командный зачёт может быть недоступен (например, в команде больше участников, чем допускает формат).
    getJson<TeamResultRow[]>(`${base}/results/teams`).catch(() => []),
  ]);
  const apparatusRows = await Promise.all(
    live.map((a) => getJson<ApparatusResultRow[]>(`${base}/results/apparatus/${a.apparatus}`)),
  );
  return {
    competition,
    live,
    allAround,
    teams,
    apparatus: Object.fromEntries(live.map((a, i) => [a.apparatus, apparatusRows[i]!])),
  };
}

/**
 * Данные табло. Обновляются по событиям сервера и на всякий случай раз в 30 секунд.
 * onApproved получает каждую новую утверждённую оценку для всплывающей строки.
 */
export function useBoard(competitionId: string, onApproved: (p: PerformanceView) => void) {
  const [data, setData] = useState<BoardData | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const approvedRef = useRef(onApproved);
  approvedRef.current = onApproved;

  const refresh = useCallback(() => {
    load(competitionId)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
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
      approvedRef.current(p);
      schedule();
    });
    return () => {
      clearInterval(poll);
      if (timer.current) clearTimeout(timer.current);
      socket.close();
    };
  }, [competitionId, refresh, schedule]);

  return { data, connected, error };
}
