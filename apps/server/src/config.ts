import { join } from "node:path";

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
}

export const APP_CONFIG = Symbol("APP_CONFIG");

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
  };
}
