import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CloudBackupService } from "../src/backup/cloud-backup.service";
import { signS3Request } from "../src/backup/s3";
import { loadConfig } from "../src/config";
import { ADMIN_TOKEN, api, startApp } from "./helpers";

describe("подпись запросов к хранилищу S3", () => {
  it("совпадает с примером из документации AWS (GET с Range)", () => {
    const headers = signS3Request(
      { accessKey: "AKIAIOSFODNN7EXAMPLE", secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1" },
      {
        method: "GET",
        url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
        headers: { range: "bytes=0-9" },
        payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      },
      new Date("2013-05-24T00:00:00Z"),
    );
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });
});

describe("настройка хранилища", () => {
  const base = { DATABASE_URL: "postgres://x", ADMIN_TOKEN: "0123456789abcdef" };
  it("без строк S3 копия в облако выключена", () => {
    expect(loadConfig(base).s3).toBeUndefined();
  });
  it("называет недостающие строки, если заполнена только часть", () => {
    expect(() => loadConfig({ ...base, S3_ENDPOINT: "https://s3.example", S3_BUCKET: "b" })).toThrow(/S3_ACCESS_KEY, S3_SECRET_KEY/);
  });
});

interface Put {
  path: string;
  body: string;
  auth: string;
}

describe("копия в облако", () => {
  let app: INestApplication;
  let s3: Server;
  let fail = false;
  const puts: Put[] = [];
  const dir = mkdtempSync(join(tmpdir(), "ag-cloud-"));
  const exportDir = join(dir, "tournaments");
  mkdirSync(exportDir);

  beforeAll(async () => {
    s3 = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        if (fail) {
          res.writeHead(403).end("<Error><Code>AccessDenied</Code></Error>");
          return;
        }
        puts.push({ path: decodeURIComponent(req.url ?? ""), body: Buffer.concat(chunks).toString(), auth: String(req.headers.authorization) });
        res.writeHead(200).end();
      });
    });
    await new Promise<void>((resolve) => s3.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(s3.address() as AddressInfo).port}`;
    ({ app } = await startApp({
      exportDir,
      s3: { endpoint, bucket: "ffk", accessKey: "key", secretKey: "secret", region: "ru-1", prefix: "gymnastics", interval: 900, backupDir: dir },
    }));
  });

  afterAll(async () => {
    await app?.close();
    s3?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("отправляет свежую копию базы и файлы турниров, а неизменённое не повторяет", async () => {
    writeFileSync(join(dir, "gymnastics-20261114-100000.dump"), "old");
    utimesSync(join(dir, "gymnastics-20261114-100000.dump"), new Date("2026-11-14T07:00:00Z"), new Date("2026-11-14T07:00:00Z"));
    writeFileSync(join(dir, "gymnastics-20261114-100500.dump"), "new");
    writeFileSync(join(exportDir, "Кубок (01234567).json"), "{}");
    const service = app.get(CloudBackupService);

    const now = new Date(2026, 10, 14, 10, 6);
    expect(await service.run(now)).toEqual([
      "gymnastics/db/latest.dump",
      "gymnastics/db/daily/2026-11-14.dump",
      "gymnastics/tournaments/Кубок (01234567).json",
    ]);
    expect(puts.map((p) => [p.path, p.body])).toEqual([
      ["/ffk/gymnastics/db/latest.dump", "new"],
      ["/ffk/gymnastics/db/daily/2026-11-14.dump", "new"],
      ["/ffk/gymnastics/tournaments/Кубок (01234567).json", "{}"],
    ]);
    expect(puts[0]!.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=key\/\d{8}\/ru-1\/s3\/aws4_request/);

    expect(await service.run(now)).toEqual([]);
    expect(puts).toHaveLength(3);
  });

  it("показывает ошибку хранилища секретариату", async () => {
    fail = true;
    writeFileSync(join(dir, "gymnastics-20261114-101000.dump"), "newer");
    const admin = api(app, ADMIN_TOKEN);
    const status = (await admin.post("/cloud-backup").expect(200)).body;
    expect(status).toMatchObject({ enabled: true, bucket: "ffk", lastError: expect.stringContaining("403") });
    fail = false;
    // Кнопка запускает копирование «сейчас», поэтому копия дня — за сегодняшнюю дату сервера.
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    expect((await admin.post("/cloud-backup").expect(200)).body).toMatchObject({ lastError: null, uploaded: ["gymnastics/db/latest.dump", `gymnastics/db/daily/${today}.dump`] });
  });
});
