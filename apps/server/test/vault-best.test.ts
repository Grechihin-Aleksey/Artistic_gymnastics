import type { INestApplication } from "@nestjs/common";
import type { RulesView } from "@ag/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, api, startApp } from "./helpers";

let app: INestApplication;
let admin: ReturnType<typeof api>;
let competitionId: string;
let anna: string;
let vera: string;

beforeAll(async () => {
  ({ app } = await startApp());
  admin = api(app, ADMIN_TOKEN);
  competitionId = (await admin.post("/competitions", { name: "Первенство школ", discipline: "WAG", vaultRule: "FIG" }).expect(201)).body.id;
  const rows = [
    { bib: 1, lastName: "Орлова", firstName: "Анна" },
    { bib: 2, lastName: "Белова", firstName: "Вера" },
  ];
  [anna, vera] = (await admin.post(`/competitions/${competitionId}/gymnasts/import`, { rows }).expect(201)).body.map(
    (g: { id: string }) => g.id,
  );
  for (const [role, seat] of [["SUPERVISOR", 1], ["D", 1], ["E", 1]] as const) {
    await admin.post(`/competitions/${competitionId}/judges`, { name: `${role}${seat}`, apparatus: "VT", role, seat }).expect(201);
  }
  const vault = (gymnastId: string, attempt: number, d: number, e: number) =>
    admin.post(`/competitions/${competitionId}/manual-scores`, { gymnastId, apparatus: "VT", attempt, d, e: [e] }).expect(201);
  // Анна: 12.0 и 13.0; Вера: 12.8 и 11.6.
  await vault(anna, 1, 3, 1);
  await vault(anna, 2, 4, 1);
  await vault(vera, 1, 3.8, 1);
  await vault(vera, 2, 3, 1.4);
});

afterAll(async () => {
  await app?.close();
});

const vaultTable = async () =>
  (await api(app).get(`/competitions/${competitionId}/results/apparatus/VT`).expect(200)).body.map(
    (r: { gymnast: { id: string }; score: { total: number } }) => [r.gymnast.id, r.score.total],
  );
const allAroundVault = async () =>
  (await api(app).get(`/competitions/${competitionId}/results/all-around`).expect(200)).body.map(
    (r: { gymnast: { id: string }; apparatus: { VT: { total: number } } }) => [r.gymnast.id, r.apparatus.VT.total],
  );

describe("два опорных прыжка", () => {
  it("по FIG: в многоборье первый прыжок, на снаряде среднее двух", async () => {
    expect(await allAroundVault()).toEqual([
      [vera, 12.8],
      [anna, 12],
    ]);
    expect(await vaultTable()).toEqual([
      [anna, 12.5],
      [vera, 12.2],
    ]);
  });

  it("«лучший из двух»: везде засчитывается лучший прыжок", async () => {
    const rules = (await admin.get(`/competitions/${competitionId}/rules`).expect(200)).body as RulesView;
    expect(rules.vaultRule).toBe("FIG");
    const saved = (await admin.put(`/competitions/${competitionId}/rules`, { rules: "FIG", vaultRule: "BEST" }).expect(200))
      .body as RulesView;
    expect(saved.vaultRule).toBe("BEST");
    expect(await allAroundVault()).toEqual([
      [anna, 13],
      [vera, 12.8],
    ]);
    expect(await vaultTable()).toEqual([
      [anna, 13],
      [vera, 12.8],
    ]);
  });
});
