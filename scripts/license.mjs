// Выпуск ключей лицензии. Нужен только владельцу программы, у которого есть закрытый ключ выпуска.
//   node scripts/license.mjs issue --key путь/к/ключу.pem --org "СШОР №1, Москва" --until 2027-12-31
//   node scripts/license.mjs check AG1.…      — что внутри ключа и верна ли подпись (открытым ключом программы)
//   node scripts/license.mjs keygen папка     — новая пара ключей выпуска (после этого замените
//                                               LICENSE_PUBLIC_KEY в apps/server/src/license/license.ts)
// То же без командной строки: tools/license-issuer.html в браузере.
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [command, ...rest] = process.argv.slice(2);
const option = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

if (command === "keygen") {
  const dir = rest[0] ?? ".";
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(join(dir, "license-private.pem"), privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  console.log(`Закрытый ключ: ${join(dir, "license-private.pem")} — храните его только у себя.`);
  console.log("Открытый ключ для apps/server/src/license/license.ts:");
  console.log(publicKey.export({ type: "spki", format: "pem" }));
} else if (command === "issue") {
  const keyFile = option("key");
  const org = option("org")?.trim();
  const until = option("until");
  if (!keyFile || !org || !until) fail('Нужно: --key ключ.pem --org "Кому" --until ГГГГ-ММ-ДД');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) fail("Дата --until в виде ГГГГ-ММ-ДД, например 2027-12-31");
  const payload = { id: randomBytes(6).toString("hex"), org, until, issued: new Date().toISOString().slice(0, 10) };
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign(null, Buffer.from(`AG1.${data}`), createPrivateKey(readFileSync(keyFile)));
  console.log(`AG1.${data}.${signature.toString("base64url")}`);
} else if (command === "check") {
  const key = (rest[0] ?? "").replace(/\s+/g, "");
  const source = readFileSync(new URL("../apps/server/src/license/license.ts", import.meta.url), "utf8");
  const pem = /`(-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----)`/.exec(source)?.[1];
  const [prefix, data, signature] = key.split(".");
  if (prefix !== "AG1" || !data || !signature) fail("Это не ключ лицензии");
  const ok = verify(null, Buffer.from(`AG1.${data}`), createPublicKey(pem), Buffer.from(signature, "base64url"));
  console.log(ok ? "Подпись верна" : "Подпись НЕ верна");
  console.log(JSON.parse(Buffer.from(data, "base64url").toString("utf8")));
} else {
  fail("Команды: issue, check, keygen. Подробно — в начале файла.");
}
