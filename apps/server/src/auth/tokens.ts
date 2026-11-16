import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export function newToken(): string {
  return randomBytes(24).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function sameToken(a: string, b: string): boolean {
  const ha = Buffer.from(hashToken(a), "hex");
  const hb = Buffer.from(hashToken(b), "hex");
  return timingSafeEqual(ha, hb);
}

/**
 * Токен судьи в зашифрованном виде, чтобы секретариат мог перепечатать QR-код
 * без перевыпуска. Ключ — из токена секретариата: копия базы (в том числе в
 * облаке) без файла .env кодов не раскрывает. AES-256-GCM: iv.tag.шифр в base64url.
 */
const sealKey = (adminToken: string) => createHash("sha256").update(`judge-token:${adminToken}`).digest();

export function sealToken(token: string, adminToken: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sealKey(adminToken), iv);
  const data = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64url")).join(".");
}

/** Токен из зашифрованного вида; null, если зашифрован другим токеном секретариата или повреждён. */
export function openToken(sealed: string | null, adminToken: string): string | null {
  if (!sealed) return null;
  try {
    const [iv, tag, data] = sealed.split(".").map((p) => Buffer.from(p, "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", sealKey(adminToken), iv!);
    decipher.setAuthTag(tag!);
    return Buffer.concat([decipher.update(data!), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** Пароль секретариата хранится только солёным хешем scrypt: scrypt.соль.хеш в hex. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return ["scrypt", salt.toString("hex"), scryptSync(password, salt, 32).toString("hex")].join(".");
}

export function verifyPassword(password: string, stored: string): boolean {
  const [kind, salt, hash] = stored.split(".");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  const actual = scryptSync(password, Buffer.from(salt, "hex"), expected.length);
  return timingSafeEqual(actual, expected);
}
