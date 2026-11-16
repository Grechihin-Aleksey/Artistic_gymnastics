import { LIVE_EVENTS } from "@ag/shared";
import type { Socket } from "socket.io-client";

interface BatteryLike extends EventTarget {
  level: number;
  charging: boolean;
}

/**
 * Сообщает серверу заряд планшета: при подключении, при каждом изменении и раз в минуту.
 * Браузер на Android сообщает заряд, Safari на iPad — нет; тогда ничего не отправляется.
 * Возвращает функцию остановки.
 */
export function reportBattery(socket: Socket, nav: Navigator = navigator): () => void {
  const getBattery = (nav as Navigator & { getBattery?: () => Promise<BatteryLike> }).getBattery;
  if (typeof getBattery !== "function") return () => undefined;
  let battery: BatteryLike | null = null;
  let stopped = false;
  const send = () => {
    if (battery && socket.connected) socket.emit(LIVE_EVENTS.judgeBattery, { level: battery.level, charging: battery.charging });
  };
  const timer = setInterval(send, 60_000);
  socket.on(LIVE_EVENTS.judgeReady, send);
  getBattery
    .call(nav)
    .then((b) => {
      if (stopped) return;
      battery = b;
      b.addEventListener("levelchange", send);
      b.addEventListener("chargingchange", send);
      send();
    })
    .catch(() => undefined);
  return () => {
    stopped = true;
    clearInterval(timer);
    socket.off(LIVE_EVENTS.judgeReady, send);
    battery?.removeEventListener("levelchange", send);
    battery?.removeEventListener("chargingchange", send);
  };
}
