import type { INestApplication } from "@nestjs/common";
import { FIG_E_TOLERANCE, type RulesView } from "@ag/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, api, startApp } from "./helpers";

let app: INestApplication;
let admin: ReturnType<typeof api>;
let competitionId: string;

beforeAll(async () => {
  ({ app } = await startApp());
  admin = api(app, ADMIN_TOKEN);
  competitionId = (await admin.post("/competitions", { name: "Кубок города", discipline: "MAG" }).expect(201)).body.id;
});

afterAll(async () => {
  await app?.close();
});

const rules = async (): Promise<RulesView> =>
  (await api(app).get(`/competitions/${competitionId}/rules`).expect(200)).body;

describe("допуск расхождения сбавок E", () => {
  it("по умолчанию: таблица FIG и 0.50 для своих правил", async () => {
    const view = await rules();
    expect(view.eToleranceTable).toEqual(FIG_E_TOLERANCE);
    expect(view.eToleranceTableDefault).toBe(true);
    expect(view.eTolerance).toBe(0.5);
  });

  it("таблицу FIG можно поправить, и она остаётся, пока её не передали заново", async () => {
    const table = [
      { from: 0, tolerance: 0.8 },
      { from: 9.25, tolerance: 0.15 },
    ];
    await admin.put(`/competitions/${competitionId}/rules`, { rules: "FIG", eToleranceTable: table }).expect(200);
    let view = await rules();
    expect(view.eToleranceTableDefault).toBe(false);
    expect(view.eToleranceTable).toEqual([table[1], table[0]]);

    // Сохранение без таблицы (например, сменили правило прыжков) её не сбрасывает.
    await admin.put(`/competitions/${competitionId}/rules`, { rules: "FIG", vaultRule: "BEST" }).expect(200);
    expect((await rules()).eToleranceTable).toEqual([table[1], table[0]]);

    // «Вернуть как в FIG» — null.
    await admin.put(`/competitions/${competitionId}/rules`, { rules: "FIG", eToleranceTable: null }).expect(200);
    view = await rules();
    expect(view.eToleranceTableDefault).toBe(true);
    expect(view.eToleranceTable).toEqual(FIG_E_TOLERANCE);
  });

  it("таблица без строки «от 0» не сохраняется", async () => {
    await admin
      .put(`/competitions/${competitionId}/rules`, { rules: "FIG", eToleranceTable: [{ from: 9, tolerance: 0.3 }] })
      .expect(400);
  });

  it("свои правила: одно число", async () => {
    await admin.put(`/competitions/${competitionId}/rules`, { rules: "CUSTOM", eTolerance: 0.3 }).expect(200);
    expect((await rules()).eTolerance).toBe(0.3);
    await admin.put(`/competitions/${competitionId}/rules`, { rules: "CUSTOM", eTolerance: 0 }).expect(400);
  });
});
