import { createHash, createHmac } from "node:crypto";

/** Доступ к облачному хранилищу по протоколу S3 (Beget, Yandex, Selectel, MinIO и другие). */
export interface S3Target {
  /** Адрес хранилища, например https://s3.ru1.storage.beget.cloud */
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region: string;
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();

/** Кодирование пути по правилам AWS: всё, кроме букв, цифр и -._~, а «/» между частями ключа остаётся. */
function encodePath(path: string): string {
  return path
    .split("/")
    .map((part) => encodeURIComponent(part).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/");
}

/**
 * Подпись запроса AWS Signature Version 4. Возвращает заголовки, которые нужно
 * добавить к запросу. Своя реализация вместо AWS SDK: нужны только PUT и GET,
 * а лишняя зависимость в сервере зала ни к чему.
 */
export function signS3Request(
  target: Pick<S3Target, "accessKey" | "secretKey" | "region">,
  request: { method: string; url: URL; headers?: Record<string, string>; payloadHash: string },
  now: Date = new Date(),
): Record<string, string> {
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(request.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v.trim()])),
    host: request.url.host,
    "x-amz-content-sha256": request.payloadHash,
    "x-amz-date": amzDate,
  };
  const names = Object.keys(headers).sort();
  const query = [...request.url.searchParams]
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonical = [
    request.method,
    encodePath(decodeURIComponent(request.url.pathname)),
    query,
    names.map((n) => `${n}:${headers[n]}\n`).join(""),
    names.join(";"),
    request.payloadHash,
  ].join("\n");
  const scope = `${day}/${target.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${target.secretKey}`, day), target.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${target.accessKey}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
  };
}

/** Адрес объекта в стиле «хранилище/бакет/ключ»: его понимают все S3-совместимые хранилища. */
export function objectUrl(target: S3Target, key: string): URL {
  return new URL(`${target.endpoint.replace(/\/+$/, "")}/${encodePath(target.bucket)}/${encodePath(key)}`);
}

/** Положить файл в хранилище. Ошибка хранилища поднимается с его ответом. */
export async function putObject(target: S3Target, key: string, body: Buffer, contentType = "application/octet-stream"): Promise<void> {
  const url = objectUrl(target, key);
  const headers = signS3Request(target, {
    method: "PUT",
    url,
    headers: { "content-type": contentType },
    payloadHash: sha256(body),
  });
  delete headers.host;
  let response: Response;
  try {
    response = await fetch(url, { method: "PUT", headers, body: new Uint8Array(body), signal: AbortSignal.timeout(120_000) });
  } catch {
    // Обычно это нет интернета или неверный адрес S3_ENDPOINT.
    throw new Error(`нет связи с хранилищем ${url.host}`);
  }
  if (!response.ok) {
    const text = (await response.text().catch(() => "")).slice(0, 300);
    throw new Error(`хранилище ответило ${response.status}${text ? `: ${text}` : ""}`);
  }
}
