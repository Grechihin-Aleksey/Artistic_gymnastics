import { useEffect, useState } from "react";

/**
 * Не даёт экрану планшета погаснуть, пока открыта страница судьи. Уснувший планшет
 * теряет связь с сервером, и судья узнаёт о вызове участника с опозданием.
 *
 * Браузер даёт удерживать экран (Wake Lock) только на страницах по https, а сервер в
 * зале работает по http. Поэтому, если Wake Lock недоступен, страница после первого
 * касания запускает крошечное беззвучное видео по кругу: пока видео играет, планшет
 * не гасит экран.
 */
export type KeepAwakeState = "lock" | "video" | "waiting" | "unsupported";

const MP4 = "data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMrbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAB9AAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAlV0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAB9AAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAfQAAAAAAABAAAAAAHNbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAgABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABeG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAThzdGJsAAAAuHN0c2QAAAAAAAAAAQAAAKhhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFUxhdmM2MC4zMS4xMDIgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAALmF2Y0MBQsAK/+EAFmdCwArZHsBEAAADAAQAAAMACDxImSABAAVoy4PLIAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAApAAAAKQAAAABhzdHRzAAAAAAAAAAEAAAACAABAAAAAABRzdHNzAAAAAAAAAAEAAAABAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAACAAAAAQAAABxzdHN6AAAAAAAAAAAAAAACAAAChgAAAAoAAAAUc3RjbwAAAAAAAAABAAADWwAAAGJ1ZHRhAAAAWm1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALWlsc3QAAAAlqXRvbwAAAB1kYXRhAAAAAQAAAABMYXZmNjAuMTYuMTAwAAAACGZyZWUAAAKYbWRhdAAAAnAGBf//bNxF6b3m2Ui3lizYINkj7u94MjY0IC0gY29yZSAxNjQgcjMxMDggMzFlMTlmOSAtIEguMjY0L01QRUctNCBBVkMgY29kZWMgLSBDb3B5bGVmdCAyMDAzLTIwMjMgLSBodHRwOi8vd3d3LnZpZGVvbGFuLm9yZy94MjY0Lmh0bWwgLSBvcHRpb25zOiBjYWJhYz0wIHJlZj0zIGRlYmxvY2s9MTowOjAgYW5hbHlzZT0weDE6MHgxMTEgbWU9aGV4IHN1Ym1lPTcgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0xNiBjaHJvbWFfbWU9MSB0cmVsbGlzPTEgOHg4ZGN0PTAgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0xIGxvb2thaGVhZF90aHJlYWRzPTEgc2xpY2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJsYWNlZD0wIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MCB3ZWlnaHRwPTAga2V5aW50PTI1MCBrZXlpbnRfbWluPTEgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD00MCByYz1jcmYgbWJ0cmVlPTEgY3JmPTIzLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MToxLjAwAIAAAAAOZYiEBb///w9FAAFPf4AAAAAGQZo4CvqA";
const WEBM = "data:video/webm;base64,GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAH8EU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHYTbuMU6uEElTDZ1OsggEeTbuMU6uEHFO7a1OsggHm7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirXsYMPQkBNgI1MYXZmNjAuMTYuMTAwV0GNTGF2ZjYwLjE2LjEwMESJiECfQAAAAAAAFlSua8GuAQAAAAAAADjXgQFzxYjNsMJ00p2xlJyBACK1nIN1bmSIgQCGhVZfVlA4g4EBI+ODhDuaygDgibCBELqBEJqBAhJUw2f8c3OgY8CAZ8iaRaOHRU5DT0RFUkSHjUxhdmY2MC4xNi4xMDBzc9ZjwItjxYjNsMJ00p2xlGfIoUWjh0VOQ09ERVJEh5RMYXZjNjAuMzEuMTAyIGxpYnZweGfIoUWjiERVUkFUSU9ORIeTMDA6MDA6MDIuMDAwMDAwMDAwAB9DtnXC54EAo6OBAACAEAIAnQEqEAAQAABHCIWFiJmEiAICAAwNYAD+/6tQgKOYgQPoALEBAAUQrAAYADA/9AwAAAD+9rkAHFO7a5G7j7OBALeK94EB8YIBn/CBAw==";

interface WakeLockSentinelLike {
  released: boolean;
  release(): Promise<void>;
}
interface WakeLockLike {
  request(type: "screen"): Promise<WakeLockSentinelLike>;
}

function makeVideo(): HTMLVideoElement {
  const video = document.createElement("video");
  video.setAttribute("playsinline", "");
  video.setAttribute("muted", "");
  video.setAttribute("aria-hidden", "true");
  video.muted = true;
  video.loop = true;
  // Видео должно быть «на экране», иначе часть браузеров не считает его воспроизведением.
  video.style.cssText = "position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0.01;pointer-events:none;";
  for (const [src, type] of [
    [WEBM, "video/webm"],
    [MP4, "video/mp4"],
  ] as const) {
    const source = document.createElement("source");
    source.src = src;
    source.type = type;
    video.appendChild(source);
  }
  return video;
}

export function useKeepAwake(): KeepAwakeState {
  const [state, setState] = useState<KeepAwakeState>("waiting");

  useEffect(() => {
    let disposed = false;
    let sentinel: WakeLockSentinelLike | null = null;
    let video: HTMLVideoElement | null = null;
    const wakeLock = (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock;

    const playVideo = () => {
      if (disposed) return;
      if (!video) {
        video = makeVideo();
        document.body.appendChild(video);
      }
      video.play().then(
        () => !disposed && setState("video"),
        () => !disposed && setState("unsupported"),
      );
    };

    const acquire = async () => {
      if (disposed || document.visibilityState !== "visible") return;
      if (wakeLock && window.isSecureContext) {
        try {
          if (!sentinel || sentinel.released) sentinel = await wakeLock.request("screen");
          if (!disposed) setState("lock");
          return;
        } catch {
          // Браузер отказал (например, экономия заряда) — пробуем видео.
        }
      }
      // Без касания видео не запустится, поэтому ждём его; если касание уже было, play() сработает сразу.
      if (video) playVideo();
    };

    const locked = () => Boolean(sentinel && !sentinel.released);
    const onTouch = () => {
      if (locked() || (video && !video.paused)) return;
      void acquire().then(() => {
        if (!locked()) playVideo();
      });
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") void acquire();
    };

    void acquire();
    document.addEventListener("pointerdown", onTouch, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      document.removeEventListener("pointerdown", onTouch);
      document.removeEventListener("visibilitychange", onVisibility);
      void sentinel?.release().catch(() => undefined);
      if (video) {
        video.pause();
        video.remove();
      }
    };
  }, []);

  return state;
}
