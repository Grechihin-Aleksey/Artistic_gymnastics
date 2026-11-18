import type { INestApplication } from "@nestjs/common";
import { categoryVaultMode, type BoardSnapshot, type RulesView } from "@ag/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, api, startApp } from "./helpers";

let app: INestApplication;
let admin: ReturnType<typeof api>;
let competitionId: string;
const ids: Record<string, string> = {};

// Прыжки: первый 12.0, второй 13.0 (у всех одинаковые, чтобы видно было правило разряда).
beforeAll(async () => {
  ({ app } = await startApp());
  admin = api(app, ADMIN_TOKEN);
  competitionId = (
    await admin.post("/competitions", { name: "Первенство области", discipline: "WAG", teamEvent: false }).expect(201)
  ).body.id;
  const rows = [
    { bib: 1, lastName: "Орлова", firstName: "Анна", category: "3 юн", team: "Олимп" },
    { bib: 2, lastName: "Белова", firstName: "Вера", category: "2 сп", team: "Олимп" },
    { bib: 3, lastName: "Седова", firstName: "Нина", category: "1 сп" },
    { bib: 4, lastName: "Козлова", firstName: "Ольга", category: "КМС" },
  ];
  const created = (await admin.post(`/competitions/${competitionId}/gymnasts/import`, { rows }).expect(201)).body as {
    id: string;
    bib: number;
  }[];
  for (const g of created) ids[g.bib] = g.id;
  for (const [role, seat] of [["SUPERVISOR", 1], ["D", 1], ["E", 1]] as const) {
    await admin.post(`/competitions/${competitionId}/judges`, { name: `${role}${seat}`, apparatus: "VT", role, seat }).expect(201);
  }
  for (const bib of [1, 2, 3, 4]) {
    await admin
      .post(`/competitions/${competitionId}/manual-scores`, { gymnastId: ids[bib], apparatus: "VT", attempt: 1, d: 3, e: [1] })
      .expect(201);
    // КМС прыгает один раз.
    if (bib !== 4) {
      await admin
        .post(`/competitions/${competitionId}/manual-scores`, { gymnastId: ids[bib], apparatus: "VT", attempt: 2, d: 4, e: [1] })
        .expect(201);
    }
  }
});

afterAll(async () => {
  await app?.close();
});

describe("опорный прыжок по разряду", () => {
  it("узнаёт разряды по названию", () => {
    expect(categoryVaultMode("3 юношеский")).toBe("best");
    expect(categoryVaultMode("I юн.")).toBe("best");
    expect(categoryVaultMode("2 спортивный")).toBe("best");
    expect(categoryVaultMode("1 сп")).toBe("average");
    expect(categoryVaultMode("1 разряд")).toBe("average");
    expect(categoryVaultMode("КМС")).toBe("first");
    expect(categoryVaultMode("МС")).toBe("first");
    expect(categoryVaultMode("Юниорки")).toBeNull();
  });

  it("у девочек по умолчанию: 3 юн–2 сп лучший, 1 сп среднее, КМС один прыжок", async () => {
    const rules = (await admin.get(`/competitions/${competitionId}/rules`).expect(200)).body as RulesView;
    expect(rules.vaultRule).toBe("CATEGORY");
    const aa = (await api(app).get(`/competitions/${competitionId}/results/all-around`).expect(200)).body as {
      gymnast: { bib: number };
      apparatus: { VT: { total: number } };
    }[];
    const vt = Object.fromEntries(aa.map((r) => [r.gymnast.bib, r.apparatus.VT.total]));
    expect(vt).toEqual({ 1: 13, 2: 13, 3: 12.5, 4: 12 });
  });

  it("на снаряде: лучший у юношеских и 2 сп, среднее у 1 сп", async () => {
    const table = (await api(app).get(`/competitions/${competitionId}/results/apparatus/VT`).expect(200)).body as {
      gymnast: { bib: number };
      score: { total: number };
    }[];
    expect(Object.fromEntries(table.map((r) => [r.gymnast.bib, r.score.total]))).toEqual({ 1: 13, 2: 13, 3: 12.5, 4: 12 });
  });
});

describe("опорный прыжок: выбор секретаря у разряда", () => {
  it("подсказка по названию видна в правилах, выбор пересчитывает места", async () => {
    const rules = (await admin.get(`/competitions/${competitionId}/rules`).expect(200)).body as RulesView;
    const byName = Object.fromEntries(rules.categories.map((c) => [c.name, c]));
    expect(byName["1 сп"]!.vaultMode).toBeNull();
    expect(byName["1 сп"]!.vaultModeAuto).toBe("average");
    const saved = (
      await admin
        .put(`/competitions/${competitionId}/rules`, {
          rules: "FIG",
          vaultRule: "CATEGORY",
          vaultModes: [
            { categoryId: byName["1 сп"]!.id, mode: "best" },
            { categoryId: byName["3 юн"]!.id, mode: "first" },
          ],
        })
        .expect(200)
    ).body as RulesView;
    expect(saved.categories.find((c) => c.name === "1 сп")!.vaultMode).toBe("best");
    const aa = (await api(app).get(`/competitions/${competitionId}/results/all-around`).expect(200)).body as {
      gymnast: { bib: number };
      apparatus: { VT: { total: number } };
    }[];
    expect(Object.fromEntries(aa.map((r) => [r.gymnast.bib, r.apparatus.VT.total]))).toEqual({ 1: 12, 2: 13, 3: 13, 4: 12 });
    const table = (await api(app).get(`/competitions/${competitionId}/results/apparatus/VT`).expect(200)).body as {
      gymnast: { bib: number };
      score: { total: number };
    }[];
    expect(Object.fromEntries(table.map((r) => [r.gymnast.bib, r.score.total]))).toEqual({ 1: 12, 2: 13, 3: 13, 4: 12 });
  });
});

describe("только личное первенство", () => {
  it("команды не считаются и не показываются на табло", async () => {
    expect((await api(app).get(`/competitions/${competitionId}/results/teams`).expect(200)).body).toEqual([]);
    const board = (await api(app).get(`/competitions/${competitionId}/results/snapshot`).expect(200)).body as BoardSnapshot;
    expect(board.categories.every((c) => c.teams.length === 0)).toBe(true);
    await admin.get(`/competitions/${competitionId}/protocols/teams`).expect(422);
  });

  it("командный зачёт можно включить в правилах", async () => {
    const saved = (
      await admin.put(`/competitions/${competitionId}/rules`, { rules: "FIG", vaultRule: "CATEGORY", teamEvent: true }).expect(200)
    ).body as RulesView;
    expect(saved.teamEvent).toBe(true);
    const teams = (await api(app).get(`/competitions/${competitionId}/results/teams`).expect(200)).body as unknown[];
    expect(teams.length).toBeGreaterThan(0);
  });
});
