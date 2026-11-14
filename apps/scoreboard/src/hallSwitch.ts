import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import { LIVE_EVENTS, type BoardSwitch } from "@ag/shared";

/**
 * Какую часть турнира показать дальше. auto — следующую по кругу, show — выбранную
 * секретариатом (только по новой команде, чтобы переключатель на табло тоже работал).
 * null — ничего не менять.
 */
export function nextPart(
  sw: BoardSwitch | null,
  group: string[],
  current: string,
  reason: "command" | "timer",
): string | null {
  if (!sw || group.length < 2) return null;
  if (sw.mode === "show" && reason === "command") return sw.show && group.includes(sw.show) && sw.show !== current ? sw.show : null;
  if (sw.mode === "auto" && reason === "timer") return group[(group.indexOf(current) + 1) % group.length] ?? null;
  return null;
}

/**
 * Табло в зале у турнира из двух частей слушает секретариат: чередует части
 * или выводит выбранную. На сайте не работает: там части переключает зритель.
 */
export function useHallSwitch(group: string[] | undefined, current: string | null, go: (competitionId: string) => void, enabled: boolean) {
  const [sw, setSw] = useState<BoardSwitch | null>(null);
  const applied = useRef<string | null>(null);
  const first = group?.[0];
  const key = group?.join(",");

  useEffect(() => {
    if (!enabled || !first || !key) return;
    let alive = true;
    // Та же настройка из сверки не должна сбрасывать отсчёт чередования.
    const update = (next: BoardSwitch | null) => setSw((prev) => (prev?.at === next?.at ? prev : next));
    const load = () =>
      fetch(`/competitions/${first}`)
        .then((r) => (r.ok ? (r.json() as Promise<{ boardSwitch?: BoardSwitch | null }>) : null))
        .then((c) => alive && c && update(c.boardSwitch ?? null))
        .catch(() => undefined);
    void load();
    // На случай потерянного события сверяемся раз в 15 секунд.
    const poll = setInterval(load, 15_000);
    const socket = io("/live", { transports: ["websocket", "polling"] });
    socket.on("connect", () => {
      for (const id of key.split(",")) socket.emit(LIVE_EVENTS.join, { competitionId: id });
    });
    socket.on(LIVE_EVENTS.boardSwitch, (next: BoardSwitch) => update(next));
    return () => {
      alive = false;
      clearInterval(poll);
      socket.close();
    };
  }, [enabled, first, key]);

  // Новая команда секретариата «показать часть» выполняется один раз.
  useEffect(() => {
    if (!sw || !group || !current || applied.current === sw.at) return;
    applied.current = sw.at;
    const target = nextPart(sw, group, current, "command");
    if (target) go(target);
  }, [sw, group, current, go]);

  // Чередование: отсчёт заново после каждой смены части, в том числе ручной.
  useEffect(() => {
    if (sw?.mode !== "auto" || !group || !current) return;
    const timer = setTimeout(() => {
      const target = nextPart(sw, group, current, "timer");
      if (target) go(target);
    }, sw.every * 1000);
    return () => clearTimeout(timer);
  }, [sw, group, current, go]);
}
