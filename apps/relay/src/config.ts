import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface RelayConfig {
  port: number;
  /** Токен, с которым сервер в зале присылает результаты. */
  token: string;
  /** Куда сохранять последние снимки, чтобы пережить перезапуск. */
  dataDir: string;
  /** Сборка табло; раздаётся по адресу /widget/. */
  widgetDist?: string;
  /** Скрипт встраивания embed.js. */
  publicDir: string;
}

const here = dirname(fileURLToPath(import.meta.url));

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const token = env.RELAY_TOKEN;
  if (!token || token.length < 16) {
    throw new Error("RELAY_TOKEN должен быть задан и содержать не меньше 16 символов");
  }
  return {
    port: Number(env.PORT ?? 8080),
    token,
    dataDir: env.DATA_DIR ?? join(here, "..", "data"),
    widgetDist: env.WIDGET_DIST ?? join(here, "..", "..", "scoreboard", "dist"),
    publicDir: join(here, "..", "public"),
  };
}
