import { LIVE_EVENTS } from "@ag/shared";
import { describe, expect, it, vi } from "vitest";
import { LiveLink, PROBE_TIMEOUT_MS, READY_TIMEOUT_MS, RETRY_AFTER_SERVER_CLOSE_MS, WATCHDOG_MS, type LinkEnv, type LinkSocket } from "./liveLink";

/** Сокет-заглушка: тест сам решает, когда сервер ответил. */
class FakeSocket implements LinkSocket {
  connected = false;
  active = true;
  connects = 0;
  disconnects = 0;
  probes: ((err: unknown) => void)[] = [];
  private handlers = new Map<string, ((...args: any[]) => void)[]>();
  on(event: string, listener: (...args: any[]) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener]);
  }
  fire(event: string, ...args: unknown[]) {
    for (const h of this.handlers.get(event) ?? []) h(...args);
  }
  connect() {
    this.connects++;
    this.active = true;
  }
  disconnect() {
    this.disconnects++;
    const was = this.connected;
    this.connected = false;
    this.active = false;
    if (was) this.fire("disconnect", "io client disconnect");
  }
  timeout() {
    return { emit: (_e: string, _p: unknown, ack: (err: unknown) => void) => void this.probes.push(ack) };
  }
  /** Сервер принял подключение и подписал судью на бригаду. */
  serverAccepts() {
    this.connected = true;
    this.fire("connect");
    this.fire(LIVE_EVENTS.judgeReady, { judgeId: "j1" });
  }
  wifiLost() {
    this.connected = false;
    this.fire("disconnect", "ping timeout");
  }
}

function fakeEnv() {
  const listeners = new Map<string, Set<() => void>>();
  let visible = true;
  const env: LinkEnv = {
    addEventListener: (t, l) => void listeners.set(t, (listeners.get(t) ?? new Set()).add(l)),
    removeEventListener: (t, l) => void listeners.get(t)?.delete(l),
    isVisible: () => visible,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
  };
  return {
    env,
    emit: (type: string) => listeners.get(type)?.forEach((l) => l()),
    setVisible: (v: boolean) => (visible = v),
    count: (type: string) => listeners.get(type)?.size ?? 0,
  };
}

function setup() {
  vi.useFakeTimers();
  const socket = new FakeSocket();
  const browser = fakeEnv();
  const onReady = vi.fn();
  const onRejected = vi.fn();
  const link = new LiveLink(socket, "c1", { onReady, onRejected }, browser.env, () => Date.now());
  return { socket, browser, onReady, onRejected, link };
}

describe("автоподключение планшета судьи", () => {
  it("судья вернулся в зал: подключение открывается сразу, и планшет снова получает данные", () => {
    const { socket, browser, onReady, link } = setup();
    socket.serverAccepts();
    expect(link.current()).toBe("ready");
    expect(onReady).toHaveBeenCalledTimes(1);

    socket.wifiLost();
    expect(link.current()).toBe("connecting");

    // Wi-Fi снова есть: не ждём паузу socket.io, а подключаемся заново.
    vi.setSystemTime(Date.now() + 5_000);
    const before = socket.connects;
    browser.emit("online");
    expect(socket.connects).toBe(before + 1);
    socket.serverAccepts();
    expect(link.current()).toBe("ready");
    // Повторный onReady: экран перечитывает выступления и досылает оценки из очереди.
    expect(onReady).toHaveBeenCalledTimes(2);
    link.stop();
    vi.useRealTimers();
  });

  it("на связи только после подтверждения сервера; нет подтверждения — переподключается", () => {
    const { socket, link } = setup();
    socket.connected = true;
    socket.fire("connect");
    expect(link.current()).toBe("connecting");
    const before = socket.connects;
    vi.advanceTimersByTime(READY_TIMEOUT_MS + 10);
    expect(socket.connects).toBe(before + 1);
    link.stop();
    vi.useRealTimers();
  });

  it("экран снова включён: живую связь проверяет запросом, мёртвую открывает заново", () => {
    const { socket, browser, link } = setup();
    socket.serverAccepts();
    vi.setSystemTime(Date.now() + 5_000);

    browser.setVisible(true);
    browser.emit("visibilitychange");
    expect(socket.probes).toHaveLength(1);
    const before = socket.connects;
    // Ответа нет: подключение повисло, пока планшет спал.
    socket.probes[0]!(new Error("timeout"));
    expect(socket.connects).toBe(before + 1);

    // Связи уже нет — подключаемся без проверки.
    socket.wifiLost();
    vi.setSystemTime(Date.now() + 5_000);
    browser.emit("pageshow");
    expect(socket.connects).toBe(before + 2);
    link.stop();
    vi.useRealTimers();
  });

  it("пачка событий focus/pageshow/online не переоткрывает подключение много раз", () => {
    const { socket, browser, link } = setup();
    socket.serverAccepts();
    socket.wifiLost();
    vi.setSystemTime(Date.now() + 5_000);
    const before = socket.connects;
    browser.emit("online");
    browser.emit("focus");
    browser.emit("pageshow");
    expect(socket.connects).toBe(before + 1);
    link.stop();
    vi.useRealTimers();
  });

  it("сервер сам закрыл подключение — планшет переподключается через пару секунд", () => {
    const { socket, link } = setup();
    socket.serverAccepts();
    socket.connected = false;
    socket.active = false;
    socket.fire("disconnect", "io server disconnect");
    const before = socket.connects;
    vi.advanceTimersByTime(RETRY_AFTER_SERVER_CLOSE_MS + 10);
    expect(socket.connects).toBe(before + 1);
    link.stop();
    vi.useRealTimers();
  });

  it("сторож возобновляет подключение, если попытки прекратились", () => {
    const { socket, link } = setup();
    socket.active = false;
    const before = socket.connects;
    vi.advanceTimersByTime(WATCHDOG_MS + 10);
    expect(socket.connects).toBe(before + 1);
    link.stop();
    vi.useRealTimers();
  });

  it("код входа больше не действует — не переподключается и сообщает об этом", () => {
    const { socket, browser, onRejected, link } = setup();
    socket.connected = true;
    socket.fire("connect");
    socket.fire(LIVE_EVENTS.judgeRejected);
    socket.connected = false;
    socket.active = false;
    socket.fire("disconnect", "io server disconnect");
    expect(link.current()).toBe("rejected");
    expect(onRejected).toHaveBeenCalledTimes(1);
    const before = socket.connects;
    vi.advanceTimersByTime(WATCHDOG_MS * 2);
    browser.emit("online");
    expect(socket.connects).toBe(before);

    // Проверка /me показала, что код всё же действует: подключаемся снова.
    link.allowAgain();
    expect(socket.connects).toBe(before + 1);
    link.stop();
    vi.useRealTimers();
  });

  it("после закрытия экрана судьи ничего не слушает", () => {
    const { browser, link } = setup();
    expect(browser.count("online")).toBe(1);
    link.stop();
    expect(browser.count("online")).toBe(0);
    expect(browser.count("visibilitychange")).toBe(0);
    expect(PROBE_TIMEOUT_MS).toBeGreaterThan(0);
    vi.useRealTimers();
  });
});
