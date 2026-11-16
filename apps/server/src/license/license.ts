import { createPublicKey, verify } from "node:crypto";

/**
 * Открытый ключ выпуска лицензий. Закрытая пара к нему есть только у владельца программы:
 * без неё подписать новый ключ лицензии нельзя.
 */
export const LICENSE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEApnKYVH3q06ciiVlK3GhR8TZaWWaU0ej7WY54rnsQVg0=
-----END PUBLIC KEY-----`;

/** Ключ лицензии: AG1.<данные в base64url>.<подпись Ed25519 в base64url>. */
const PREFIX = "AG1";

export interface License {
  /** Номер лицензии, чтобы различать выданные ключи. */
  id: string;
  /** Кому выдана: организация или человек. */
  org: string;
  /** Последний день работы, ГГГГ-ММ-ДД включительно. */
  until: string;
  /** Когда выдана, ГГГГ-ММ-ДД. */
  issued: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Данные лицензии, если подпись верна; null — ключ поддельный, повреждён или не отсюда. */
export function readLicense(key: string, publicKey: string = LICENSE_PUBLIC_KEY): License | null {
  const parts = key.replace(/\s+/g, "").split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  const [, data, signature] = parts as [string, string, string];
  try {
    const ok = verify(null, Buffer.from(`${PREFIX}.${data}`), createPublicKey(publicKey), Buffer.from(signature, "base64url"));
    if (!ok) return null;
    const value: unknown = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    if (typeof value !== "object" || value === null) return null;
    const { id, org, until, issued } = value as Record<string, unknown>;
    if (typeof id !== "string" || typeof org !== "string" || typeof until !== "string" || !DATE.test(until)) return null;
    return { id, org, until, issued: typeof issued === "string" ? issued : "" };
  } catch {
    return null;
  }
}

/** Дата ГГГГ-ММ-ДД по часам сервера (часовой пояс из TZ). */
export function localDate(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** Сколько дней лицензия ещё работает, считая сегодняшний; 0 и меньше — срок истёк. */
export function daysLeft(until: string, today: string): number {
  return Math.round((Date.parse(`${until}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000) + 1;
}
