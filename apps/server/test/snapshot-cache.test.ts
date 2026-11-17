import { describe, expect, it } from "vitest";
import { SNAPSHOT_TTL_MS, SnapshotCache } from "../src/results/snapshot-cache";

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

describe("снимок результатов считается один раз на всех", () => {
  it("одновременные запросы ждут один расчёт, следующие берут готовый", async () => {
    const cache = new SnapshotCache();
    let calls = 0;
    const gate = deferred<string>();
    const compute = () => {
      calls++;
      return gate.promise;
    };
    const many = Array.from({ length: 50 }, () => cache.get("c1", compute));
    gate.resolve("снимок");
    expect(await Promise.all(many)).toEqual(Array(50).fill("снимок"));
    expect(await cache.get("c1", compute)).toBe("снимок");
    expect(calls).toBe(1);
    // У другого турнира свой снимок.
    await cache.get("c2", async () => "другой");
    expect(calls).toBe(1);
  });

  it("правка сбрасывает снимок, а посчитанный во время правки не запоминается", async () => {
    const cache = new SnapshotCache();
    let n = 0;
    const compute = async () => `v${++n}`;
    expect(await cache.get("c1", compute)).toBe("v1");
    cache.invalidate();
    expect(await cache.get("c1", compute)).toBe("v2");

    cache.invalidate();
    const gate = deferred<string>();
    const stale = cache.get("c1", () => gate.promise);
    cache.invalidate();
    const fresh = cache.get("c1", compute);
    expect(fresh).not.toBe(stale);
    gate.resolve("старый");
    expect(await stale).toBe("старый");
    expect(await fresh).toBe("v3");
    expect(await cache.get("c1", compute)).toBe("v3");
  });

  it("ошибка расчёта не остаётся в памяти, а снимок живёт не дольше нескольких секунд", async () => {
    const cache = new SnapshotCache();
    await expect(cache.get("c1", async () => Promise.reject(new Error("база недоступна")))).rejects.toThrow("база недоступна");
    expect(await cache.get("c1", async () => "ок")).toBe("ок");
    expect(await cache.get("c1", async () => "новый", Date.now() + SNAPSHOT_TTL_MS + 10)).toBe("новый");
  });
});
