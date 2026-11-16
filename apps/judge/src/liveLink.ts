import { LIVE_EVENTS } from "@ag/shared";

/** Сколько ждать от сервера подтверждения подписки на бригаду, прежде чем переподключиться. */
export const READY_TIMEOUT_MS = 5_000;
/** Сколько ждать ответа на проверку связи, когда планшет «проснулся». */
export const PROBE_TIMEOUT_MS = 3_000;
/** Через сколько переподключиться, если сервер сам закрыл подключение (например, база на миг недоступна). */
export const RETRY_AFTER_SERVER_CLOSE_MS = 2_000;
/** Как часто сторож проверяет, что попытки переподключения не прекратились. */
export const WATCHDOG_MS = 10_000;

export type LinkState = "connecting" | "ready" | "rejected";

/** Часть сокета socket.io, которой пользуется планшет. */
export interface LinkSocket {
  readonly connected: boolean;
  /** Сокет сам пытается переподключиться (socket.io). */
  readonly active: boolean;
  connect(): unknown;
  disconnect(): unknown;
  on(event: string, listener: (...args: any[]) => void): unknown;
  timeout(ms: number): { emit(event: string, payload: unknown, ack: (err: unknown) => void): unknown };
}

/** Окружение браузера: события сети и экрана, таймеры. Подменяется в тестах. */
export interface LinkEnv {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  isVisible(): boolean;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
}

export const browserEnv: LinkEnv = {
  addEventListener: (type, listener) => {
    if (type === "visibilitychange") document.addEventListener(type, listener);
    else window.addEventListener(type, listener);
  },
  removeEventListener: (type, listener) => {
    if (type === "visibilitychange") document.removeEventListener(type, listener);
    else window.removeEventListener(type, listener);
  },
  isVisible: () => document.visibilityState !== "hidden",
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => window.clearTimeout(id as number),
  setInterval: (fn, ms) => window.setInterval(fn, ms),
  clearInterval: (id) => window.clearInterval(id as number),
};

/**
 * Связь планшета судьи с сервером в зале, которая восстанавливается сама.
 *
 * Судья может унести планшет из зала: Wi-Fi пропадает, планшет засыпает, браузер
 * замораживает вкладку. Socket.io сам переподключается с паузами до 5 секунд, но
 * не во всех случаях, поэтому здесь добавлено:
 *  - как только планшет снова в сети (событие online), подключение открывается заново сразу,
 *    не дожидаясь, пока старое, уже мёртвое, отвалится по таймауту;
 *  - когда экран снова включён или вкладка снова на виду, связь проверяется запросом с ответом;
 *  - если сервер сам закрыл подключение, планшет переподключается через пару секунд;
 *  - на связи планшет считается только после подтверждения сервера, что он подписан на свою бригаду;
 *  - сторож раз в 10 секунд проверяет, что попытки подключения не прекратились.
 * Если код входа больше не действует, планшет не переподключается, а сообщает об этом (onRejected).
 */
export class LiveLink {
  private state: LinkState = "connecting";
  private rejected = false;
  private readyTimer: unknown = null;
  private retryTimer: unknown = null;
  private watchdog: unknown = null;
  private lastKick = -Infinity;
  private stopped = false;
  private readonly listeners = new Set<(state: LinkState) => void>();
  private readonly onWake = () => this.wake();
  private readonly onVisibility = () => {
    if (this.env.isVisible()) this.wake();
  };
  private readonly onOnline = () => this.reconnectNow();

  constructor(
    private readonly socket: LinkSocket,
    private readonly competitionId: string,
    private readonly handlers: { onReady: () => void; onRejected: () => void },
    private readonly env: LinkEnv = browserEnv,
    private readonly now: () => number = () => Date.now(),
  ) {
    socket.on("connect", () => {
      this.clear("readyTimer");
      this.readyTimer = env.setTimeout(() => {
        this.readyTimer = null;
        if (this.state !== "ready") this.reconnectNow(true);
      }, READY_TIMEOUT_MS);
    });
    socket.on(LIVE_EVENTS.judgeReady, () => {
      this.clear("readyTimer");
      this.set("ready");
      handlers.onReady();
    });
    socket.on(LIVE_EVENTS.judgeRejected, () => {
      this.rejected = true;
    });
    socket.on("disconnect", (reason: string) => {
      this.clear("readyTimer");
      if (this.rejected) {
        this.set("rejected");
        handlers.onRejected();
        return;
      }
      this.set("connecting");
      // Сервер закрыл подключение сам: socket.io в этом случае не переподключается.
      if (reason === "io server disconnect") this.retryLater();
    });
    socket.on("connect_error", () => {
      if (!socket.active) this.retryLater();
    });
    env.addEventListener("online", this.onOnline);
    env.addEventListener("visibilitychange", this.onVisibility);
    env.addEventListener("pageshow", this.onWake);
    env.addEventListener("focus", this.onWake);
    this.watchdog = env.setInterval(() => {
      if (!socket.connected && !socket.active) this.reconnectNow(true);
    }, WATCHDOG_MS);
  }

  current(): LinkState {
    return this.state;
  }

  subscribe(listener: (state: LinkState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Код входа снова проверен и действует: можно подключаться дальше. */
  allowAgain(): void {
    this.rejected = false;
    this.set("connecting");
    this.reconnectNow(true);
  }

  /**
   * Открыть подключение заново прямо сейчас, без паузы между попытками.
   * Чаще раза в секунду не делаем: события online, focus и pageshow приходят пачкой.
   */
  reconnectNow(force = false): void {
    if (this.stopped || this.rejected) return;
    const t = this.now();
    if (!force && t - this.lastKick < 1_000) return;
    this.lastKick = t;
    this.clear("retryTimer");
    this.socket.disconnect();
    this.socket.connect();
  }

  /** Планшет проснулся: если связи нет — подключиться сразу, если есть — проверить, что она живая. */
  wake(): void {
    if (this.stopped || this.rejected) return;
    if (!this.socket.connected) {
      this.reconnectNow();
      return;
    }
    this.socket.timeout(PROBE_TIMEOUT_MS).emit(LIVE_EVENTS.join, { competitionId: this.competitionId }, (err) => {
      if (err) this.reconnectNow(true);
    });
  }

  stop(): void {
    this.stopped = true;
    this.clear("readyTimer");
    this.clear("retryTimer");
    if (this.watchdog !== null) this.env.clearInterval(this.watchdog);
    this.env.removeEventListener("online", this.onOnline);
    this.env.removeEventListener("visibilitychange", this.onVisibility);
    this.env.removeEventListener("pageshow", this.onWake);
    this.env.removeEventListener("focus", this.onWake);
    this.listeners.clear();
  }

  private retryLater(): void {
    if (this.retryTimer !== null || this.stopped || this.rejected) return;
    this.retryTimer = this.env.setTimeout(() => {
      this.retryTimer = null;
      if (!this.socket.connected) this.reconnectNow(true);
    }, RETRY_AFTER_SERVER_CLOSE_MS);
  }

  private clear(timer: "readyTimer" | "retryTimer"): void {
    if (this[timer] !== null) this.env.clearTimeout(this[timer]);
    this[timer] = null;
  }

  private set(state: LinkState): void {
    if (this.state === state) return;
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}
