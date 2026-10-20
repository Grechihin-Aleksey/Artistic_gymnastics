// Собирает PHP-ретранслятор в папку results и архив для загрузки на хостинг:
//   pnpm --filter @ag/scoreboard build && pnpm --filter @ag/relay build:php
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const relay = join(dirname(fileURLToPath(import.meta.url)), "..");
const widget = join(relay, "..", "scoreboard", "dist");
const out = join(relay, "dist-php");
const target = join(out, "results");

if (!existsSync(join(widget, "index.html"))) {
  console.error("Нет сборки табло: сначала pnpm --filter @ag/scoreboard build");
  process.exit(1);
}
rmSync(out, { recursive: true, force: true });
mkdirSync(join(target, "data"), { recursive: true });
mkdirSync(join(target, "entry"));
for (const file of ["index.php", "config.php", ".htaccess", "data/.htaccess"]) {
  cpSync(join(relay, "php", file), join(target, file));
}
cpSync(join(relay, "public", "embed.js"), join(target, "embed.js"));
cpSync(join(relay, "public", "entry.html"), join(target, "entry", "index.html"));
cpSync(widget, join(target, "widget"), { recursive: true });
execFileSync("zip", ["-qr", "ag-relay-php.zip", "results"], { cwd: out });
console.log(`Готово: ${join(out, "ag-relay-php.zip")}`);
