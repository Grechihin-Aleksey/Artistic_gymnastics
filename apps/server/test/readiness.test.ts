import { mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import type { ReadinessView } from "@ag/shared";
import { io, type Socket } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, api, startApp } from "./helpers";

let app: INestApplication;
let url: string;
let admin: ReturnType<typeof api>;
let backupDir: string;

beforeAll(async () => {
  backupDir = await mkdtemp(join(tmpdir(), "ag-backups-"));
  ({ app, url } = await startApp({ backupDir }));
  admin = api(app, ADMIN_TOKEN);
});

afterAll(async () => {
  await app?.close();
});

const readiness = async (id: string) => (await admin.get(`/competitions/${id}/readiness`).expect(200)).body as ReadinessView;
const texts = (view: ReadinessView, group: string) => view.checks.filter((c) => c.group === group);

describe("готовность к старту", () => {
  it("новый турнир: нет участников, судей и копий", async () => {
    const id = (await admin.post("/competitions", { name: "Пустой", discipline: "WAG" }).expect(201)).body.id;
    const view = await readiness(id);
    expect(view.status).toBe("fail");
    expect(texts(view, "Участники")[0]!.status).toBe("fail");
    expect(texts(view, "Судьи").map((c) => c.status)).toEqual(["fail", "fail", "fail", "fail"]);
    expect(texts(view, "Копии")[0]!.status).toBe("fail");
    expect(texts(view, "Коллегия")[0]!.status).toBe("warn");
    await api(app).get(`/competitions/${id}/readiness`).expect(401);
  });

  it("называет пропавшие планшеты и команды, которым не подходит формат", async () => {
    const id = (await admin.post("/competitions", { name: "Кубок", discipline: "WAG" }).expect(201)).body.id;
    const rows = [1, 2, 3, 4, 5].map((bib) => ({ bib, lastName: `Участница${bib}`, firstName: "А", team: "Олимп" }));
    await admin.post(`/competitions/${id}/gymnasts/import`, { rows }).expect(201);
    let tablet = "";
    for (const apparatus of ["VT", "UB", "BB", "FX"]) {
      const sup = await admin
        .post(`/competitions/${id}/judges`, { name: `Старшая ${apparatus}`, apparatus, role: "SUPERVISOR", seat: 1, enterAllMarks: true })
        .expect(201);
      if (apparatus === "BB") tablet = sup.body.token;
      await admin.post(`/competitions/${id}/judges`, { name: `Судья D ${apparatus}`, apparatus, role: "D", seat: 1 }).expect(201);
      await admin.post(`/competitions/${id}/judges`, { name: `Судья E ${apparatus}`, apparatus, role: "E", seat: 1 }).expect(201);
    }
    await writeFile(join(backupDir, "gymnastics-20261116-100000.dump"), "x");

    const socket: Socket = io(`${url}/live`, { transports: ["websocket"], auth: { token: tablet } });
    await new Promise<void>((resolve) => socket.on("connect", resolve));
    await new Promise((r) => setTimeout(r, 50));
    const view = await readiness(id);
    socket.close();

    expect(texts(view, "Судьи").every((c) => c.status === "ok")).toBe(true);
    // Один планшет на бригаду: нужен только планшет старшего судьи.
    const tablets = texts(view, "Планшеты")[0]!;
    expect(tablets.status).toBe("warn");
    expect(tablets.text).toContain("Не на связи 3 из 4");
    expect(tablets.text).not.toContain("Бревно");
    const team = texts(view, "Команды")[0]!;
    expect(team.status).toBe("warn");
    expect(team.text).toContain("5-5-3");
    expect(texts(view, "Копии")[0]!.status).toBe("ok");
    expect(texts(view, "Сайт")[0]!.text).toContain("не подключён");
  });

  it("старая копия базы — предупреждение", async () => {
    const id = (await admin.post("/competitions", { name: "Копии", discipline: "WAG" }).expect(201)).body.id;
    const old = new Date(Date.now() - 40 * 60_000);
    await utimes(join(backupDir, "gymnastics-20261116-100000.dump"), old, old);
    const copy = texts(await readiness(id), "Копии")[0]!;
    expect(copy.status).toBe("warn");
    expect(copy.text).toContain("40 мин");
  });
});
