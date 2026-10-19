export interface AppConfig {
  databaseUrl: string;
  adminToken: string;
  port: number;
}

export const APP_CONFIG = Symbol("APP_CONFIG");

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL;
  const adminToken = env.ADMIN_TOKEN;
  if (!databaseUrl) throw new Error("Не задана переменная DATABASE_URL");
  if (!adminToken || adminToken.length < 16) {
    throw new Error("ADMIN_TOKEN должен быть задан и содержать не меньше 16 символов");
  }
  return { databaseUrl, adminToken, port: Number(env.PORT ?? 3000) };
}
