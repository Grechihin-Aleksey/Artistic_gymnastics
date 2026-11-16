import { join } from "node:path";
import type { S3Target } from "./backup/s3";

export interface AppConfig {
  databaseUrl: string;
  adminToken: string;
  port: number;
  /** Папка со сборкой страниц судей; раздаётся по адресу /judge. */
  judgeDist?: string;
  /** Папка со сборкой табло; раздаётся по адресу /board. */
  boardDist?: string;
  /** Адрес облачного ретранслятора для сайта; без него результаты остаются в зале. */
  relayUrl?: string;
  relayToken?: string;
  /** Папка для автовыгрузки турниров файлами, как кнопка «Выгрузить в файл»; без неё выгрузки нет. */
  exportDir?: string;
  /** Как часто выгружать, секунды. */
  exportInterval?: number;
  /** Как часто самому забирать онлайн-заявки с сайта, секунды; 0 — только по кнопке. */
  entriesSyncInterval?: number;
  /** Папка с копиями базы от контейнера backup: по ней «Готовность к старту» проверяет свежесть копии. */
  backupDir?: string;
  /** Без действующей лицензии — только пробные турниры. В тестах по умолчанию выключено. */
  licenseRequired?: boolean;
  /** Ключ лицензии из .env; ключ, введённый в секретариате, главнее. */
  licenseKey?: string;
  /** Открытый ключ проверки лицензий; по умолчанию — ключ владельца программы. */
  licensePublicKey?: string;
  /** Где смотреть последнюю выпущенную версию (version.json в репозитории); пусто — не проверять. */
  updateUrl?: string;
  /** Ключ GitHub для закрытого репозитория: тот же, что у «Обновить.bat». */
  githubToken?: string;
  /** Файл version.json этой установки. */
  versionFile?: string;
  /** Облачное хранилище S3 для копий базы и турниров; без него копии остаются только на ноутбуке. */
  s3?: S3Target & {
    /** Как часто отправлять, секунды. */
    interval: number;
    /** Папка внутри бакета. */
    prefix: string;
    /** Где лежат копии базы, которые делает контейнер backup. */
    backupDir: string;
  };
}

export const APP_CONFIG = Symbol("APP_CONFIG");

/** version.json в ветке main репозитория программы (через API GitHub: так работает и с ключом закрытого репозитория). */
export const DEFAULT_UPDATE_URL = "https://api.github.com/repos/Grechihin-Aleksey/Artistic_gymnastics/contents/version.json?ref=main";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL;
  const adminToken = env.ADMIN_TOKEN;
  if (!databaseUrl) throw new Error("Не задана переменная DATABASE_URL");
  if (!adminToken || adminToken.length < 16) {
    throw new Error("ADMIN_TOKEN должен быть задан и содержать не меньше 16 символов");
  }
  if (env.RELAY_URL && !env.RELAY_TOKEN) throw new Error("Для RELAY_URL нужен RELAY_TOKEN");
  return {
    databaseUrl,
    adminToken,
    port: Number(env.PORT ?? 3000),
    judgeDist: env.JUDGE_DIST ?? join(__dirname, "..", "..", "judge", "dist"),
    boardDist: env.BOARD_DIST ?? join(__dirname, "..", "..", "scoreboard", "dist"),
    relayUrl: env.RELAY_URL || undefined,
    relayToken: env.RELAY_TOKEN || undefined,
    exportDir: env.EXPORT_DIR || undefined,
    exportInterval: Number(env.EXPORT_INTERVAL ?? 1800),
    entriesSyncInterval: Number(env.ENTRIES_SYNC_INTERVAL ?? 300),
    backupDir: env.BACKUP_DIR || undefined,
    s3: loadS3(env),
    licenseRequired: true,
    licenseKey: env.LICENSE_KEY || undefined,
    updateUrl: env.UPDATE_CHECK === "off" ? undefined : env.UPDATE_URL || DEFAULT_UPDATE_URL,
    githubToken: env.GITHUB_TOKEN || undefined,
    versionFile: env.VERSION_FILE || undefined,
  };
}

function loadS3(env: NodeJS.ProcessEnv): AppConfig["s3"] {
  const required = ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY", "S3_SECRET_KEY"] as const;
  const given = required.filter((name) => env[name]);
  if (given.length === 0) return undefined;
  if (given.length < required.length) {
    const missing = required.filter((name) => !env[name]);
    throw new Error(`Для копии в облако не хватает переменных: ${missing.join(", ")}`);
  }
  return {
    endpoint: env.S3_ENDPOINT!,
    bucket: env.S3_BUCKET!,
    accessKey: env.S3_ACCESS_KEY!,
    secretKey: env.S3_SECRET_KEY!,
    region: env.S3_REGION || "ru-1",
    prefix: env.S3_PREFIX ?? "gymnastics",
    interval: Number(env.S3_INTERVAL ?? 900),
    backupDir: env.BACKUP_DIR || "/backups",
  };
}

/**
 * Заголовки запросов к ретранслятору. Токен идёт дважды: часть PHP-хостингов
 * не передаёт Authorization в скрипт, и тогда PHP-ретранслятор берёт X-Relay-Token.
 */
export function relayHeaders(config: AppConfig): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${config.relayToken}`,
    "x-relay-token": config.relayToken ?? "",
  };
}
