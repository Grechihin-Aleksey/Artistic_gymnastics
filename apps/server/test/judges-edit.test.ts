import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, api, startApp } from "./helpers";

let app: INestApplication;
let admin: ReturnType<typeof api>;

beforeAll(async () => {
  ({ app } = await startApp());
  admin = api(app, ADMIN_TOKEN);
});

afterAll(async () => {
  await app?.close();
});

describe("правка и удаление судей", () => {
  it("меняет судью, не даёт занять чужое место и трогать снаряд судьи с оценками", async () => {
    const competition = (await admin.post("/competitions", { name: "Кубок", discipline: "WAG" }).expect(201)).body;
    const gymnast = (await admin.post(`/competitions/${competition.id}/gymnasts`, { bib: 1, firstName: "Анна", lastName: "Иванова" }).expect(201)).body;
    const add = async (role: string, seat: number, apparatus = "BB") =>
      (await admin.post(`/competitions/${competition.id}/judges`, { name: `${role}${seat}`, apparatus, role, seat }).expect(201)).body as {
        id: string;
        token: string;
      };
    const d = await add("D", 1);
    const e1 = await add("E", 1);
    const e2 = await add("E", 2);
    await add("SUPERVISOR", 1);
    // Повторно на занятое место — понятная ошибка, а не сбой сервера.
    await admin.post(`/competitions/${competition.id}/judges`, { name: "Дубль", apparatus: "BB", role: "E", seat: 1 }).expect(409);

    // Флажок «один планшет» у судьи D/E не мешает его завести: он просто не действует.
    const extra = (await admin.post(`/competitions/${competition.id}/judges`, { name: "Е4", apparatus: "BB", role: "E", seat: 4, enterAllMarks: true }).expect(201)).body;
    expect(extra.enterAllMarks).toBe(false);

    // До оценок можно переставить судью куда угодно, кроме занятого места.
    const moved = (await admin.patch(`/judges/${e2.id}`, { name: "Петрова Н.", category: "1К", apparatus: "FX", seat: 3 }).expect(200)).body;
    expect(moved).toMatchObject({ name: "Петрова Н.", category: "1К", apparatus: "FX", role: "E", seat: 3 });
    expect(moved.tokenHash).toBeUndefined();
    await admin.patch(`/judges/${e1.id}`, { role: "D", seat: 1 }).expect(409);
    await admin.patch(`/judges/${e1.id}`, { apparatus: "PH" }).expect(400);

    // Судья с оценкой: ФИО можно, снаряд и удаление — нельзя.
    const perf = (await admin.post(`/competitions/${competition.id}/performances`, { gymnastId: gymnast.id, apparatus: "BB" }).expect(201)).body;
    await api(app, d.token).post("/marks", { id: randomUUID(), performanceId: perf.id, kind: "D", value: 5 }).expect(201);
    await admin.patch(`/judges/${d.id}`, { name: "Сидорова Т." }).expect(200);
    await admin.patch(`/judges/${d.id}`, { seat: 2 }).expect(409);
    await admin.delete(`/judges/${d.id}`).expect(409);

    // Без оценок — удаляется, и его QR-код больше не работает.
    await admin.delete(`/judges/${e2.id}`).expect(200);
    await api(app, e2.token).get("/me").expect(401);
    const left = (await admin.get(`/competitions/${competition.id}/judges`).expect(200)).body as { id: string; name: string }[];
    expect(left.map((j) => j.id)).not.toContain(e2.id);
    expect(left.find((j) => j.id === d.id)?.name).toBe("Сидорова Т.");

    await api(app, e1.token).delete(`/judges/${d.id}`).expect(403);

    const audit = (await admin.get(`/competitions/${competition.id}/audit`).expect(200)).body as { text: string }[];
    const texts = audit.map((a) => a.text).join("\n");
    expect(texts).toContain("Изменён судья: Судья E2 · Бревно · E2 → Судья E3 · Вольные упражнения · Петрова Н.");
    expect(texts).toContain("Удалён судья: Судья E3 · Вольные упражнения · Петрова Н.");
  });
});
