import { useEffect, useState } from "react";
import { formatTime } from "./labels";

/** Сигнал судьи за 10 секунд до конца времени. */
const SIGNAL = 10;

/**
 * Секундомер старшего судьи: время упражнения на вольных и бревне.
 * Подсказывает о превышении, а нейтральную сбавку судья вписывает сам.
 */
export function Stopwatch({ limit }: { limit: number }) {
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (startedAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [startedAt]);

  const ms = elapsed + (startedAt === null ? 0 : now - startedAt);
  const seconds = ms / 1000;
  const over = seconds > limit;
  const state = over ? "over" : seconds >= limit - SIGNAL ? "signal" : "";

  const start = () => {
    const t = Date.now();
    setNow(t);
    setStartedAt(t);
  };
  const stop = () => {
    setElapsed(ms);
    setStartedAt(null);
  };
  const reset = () => {
    setElapsed(0);
    setStartedAt(null);
  };

  return (
    <section className={`stopwatch ${state}`}>
      <div className="stopwatch-time">{formatTime(ms)}</div>
      <div className="stopwatch-limit muted">время {formatTime(limit * 1000).slice(0, -2)}</div>
      {startedAt === null ? (
        <button type="button" className="primary" onClick={start}>
          {ms > 0 ? "Продолжить" : "Старт"}
        </button>
      ) : (
        <button type="button" className="primary" onClick={stop}>
          Стоп
        </button>
      )}
      <button type="button" disabled={ms === 0} onClick={reset}>
        Сброс
      </button>
      {over && (
        <div className="stopwatch-note">
          Превышение на {formatTime(ms - limit * 1000)}: по правилам FIG нейтральная сбавка 0.10
        </div>
      )}
    </section>
  );
}
