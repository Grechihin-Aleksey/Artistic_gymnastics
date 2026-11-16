import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { crc32, safeName, zip } from "../src/protocols/zip";

describe("ZIP-архив документов", () => {
  it("CRC-32 как в ZIP", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });

  it("имена без запрещённых в Windows знаков", () => {
    expect(safeName('Кубок "Весна": 1/2')).toBe("Кубок Весна 1 2");
  });

  it("архив открывается стандартным unzip с русскими именами", () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-zip-"));
    const file = join(dir, "test.zip");
    writeFileSync(file, zip([
      { name: "Состав пакета.txt", data: Buffer.from("привет") },
      { name: "Девочки/01 Протокол.pdf", data: Buffer.alloc(5000, 7) },
    ]));
    let listing: string;
    try {
      listing = execFileSync("unzip", ["-l", file], { encoding: "utf8" });
    } catch {
      return; // unzip нет в системе — проверять нечем
    }
    expect(listing).toContain("Девочки/01 Протокол.pdf");
    expect(execFileSync("unzip", ["-p", file, "Состав пакета.txt"], { encoding: "utf8" })).toBe("привет");
    expect(execFileSync("unzip", ["-t", file], { encoding: "utf8" })).toContain("No errors");
  });
});
