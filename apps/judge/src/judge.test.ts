import { submitMarkSchema, type SubmitMarkInput } from "@ag/shared";
import { describe, expect, it, vi } from "vitest";
import { parseScore } from "./labels";
import { MarkQueue, type SendOutcome } from "./markQueue";
import { takeTokenFromLocation } from "./token";
import { uuid } from "./uuid";

const mark = (kind: SubmitMarkInput["kind"], value: number, performanceId = "p1"): SubmitMarkInput => ({
  id: uuid(),
  performanceId,
  kind,
  value,
});

describe("очередь оценок", () => {
  it("хранит оценки, пока нет связи, и отправляет их, когда связь вернулась", async () => {
    let online = false;
    const sent: SubmitMarkInput[] = [];
    const send = vi.fn(async (m: SubmitMarkInput): Promise<SendOutcome> => {
      if (!online) return { status: "retry" };
      sent.push(m);
      return { status: "ok" };
    });
    const queue = new MarkQueue(localStorage, "q1", send);
    queue.enqueue(mark("E", 1.3));
    await queue.flush();
    expect(queue.items()).toHaveLength(1);

    // перезагрузка страницы: новая очередь читает то же хранилище
    const reloaded = new MarkQueue(localStorage, "q1", send);
    expect(reloaded.items()).toHaveLength(1);

    online = true;
    await reloaded.flush();
    expect(sent.map((m) => m.value)).toEqual([1.3]);
    expect(reloaded.items()).toHaveLength(0);
  });

  it("новая оценка заменяет неотправленную оценку того же вида", () => {
    const queue = new MarkQueue(localStorage, "q2", async () => ({ status: "retry" }));
    queue.enqueue(mark("D", 5.5));
    queue.enqueue(mark("NEUTRAL", 0.1));
    queue.enqueue(mark("D", 5.6));
    expect(queue.items().map((m) => [m.kind, m.value])).toEqual([
      ["NEUTRAL", 0.1],
      ["D", 5.6],
    ]);
  });

  it("убирает отклонённую сервером оценку и сообщает причину", async () => {
    const queue = new MarkQueue(localStorage, "q3", async () => ({ status: "rejected", reason: "Оценка уже утверждена" }));
    queue.enqueue(mark("E", 1));
    const rejected = await queue.flush();
    expect(rejected.map((r) => r.reason)).toEqual(["Оценка уже утверждена"]);
    expect(queue.items()).toHaveLength(0);
  });

  it("не запускает две отправки одновременно", async () => {
    let calls = 0;
    const queue = new MarkQueue(localStorage, "q4", async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return { status: "ok" };
    });
    queue.enqueue(mark("E", 1));
    await Promise.all([queue.flush(), queue.flush()]);
    expect(calls).toBe(1);
  });
});

describe("ввод оценки", () => {
  it("принимает до трёх знаков после точки и проверяет диапазон", () => {
    expect(parseScore("1.3", "E")).toBe(1.3);
    expect(parseScore("10", "E")).toBe(10);
    expect(parseScore("10.1", "E")).toBeNull();
    expect(parseScore("15.4", "D")).toBe(15.4);
    expect(parseScore("1.", "E")).toBeNull();
    expect(parseScore("", "E")).toBeNull();
    expect(parseScore("0.1234", "NEUTRAL")).toBeNull();
  });
});

describe("вход по QR-коду", () => {
  it("забирает токен из адреса, сохраняет его и очищает адрес", () => {
    history.replaceState(null, "", "/judge/#token=abc%2Bdef");
    expect(takeTokenFromLocation(location, localStorage)).toBe("abc+def");
    expect(location.hash).toBe("");
    expect(takeTokenFromLocation(location, localStorage)).toBe("abc+def");
  });
});

describe("uuid", () => {
  it("проходит проверку сервера", () => {
    for (let i = 0; i < 50; i++) {
      expect(submitMarkSchema.safeParse(mark("E", 1, uuid())).success).toBe(true);
    }
  });
});
