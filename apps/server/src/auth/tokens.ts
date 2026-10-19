import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

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
