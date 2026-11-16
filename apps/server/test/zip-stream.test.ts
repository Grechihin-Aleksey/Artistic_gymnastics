import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, createWriteStream, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { writeZip, zipSize } from "../src/video/zip-stream";

const dir = mkdtempSync(join(tmpdir(), "ag-zip-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("архив роликов потоком", () => {
  it("пишет архив без сжатия, который открывает unzip, и заранее знает его размер", async () => {
    const a = join(dir, "a.bin");
    const b = join(dir, "b.bin");
    writeFileSync(a, Buffer.alloc(200_000, 7));
    writeFileSync(b, Buffer.from("второй файл"));
    const files = [
      { name: "Турнир/Бревно №1 Иванова Анна.mp4", path: a, size: 200_000 },
      { name: "Турнир/Вольные №2 Петрова Мария.mp4", path: b, size: statSync(b).size },
    ];
    const out = join(dir, "out.zip");
    const stream = createWriteStream(out);
    await writeZip(stream, files);
    await new Promise<void>((r) => stream.on("close", () => r()));
    expect(statSync(out).size).toBe(zipSize(files));
    execFileSync("unzip", ["-tq", out]);
    expect(execFileSync("unzip", ["-p", out, "Турнир/Вольные №2 Петрова Мария.mp4"]).toString()).toBe("второй файл");
  });
});
