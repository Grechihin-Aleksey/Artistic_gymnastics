import "reflect-metadata";
import { existsSync } from "node:fs";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { loadConfig } from "./config";

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forConfig(config), { cors: true });
  app.enableShutdownHooks();
  if (config.judgeDist && existsSync(config.judgeDist)) {
    app.useStaticAssets(config.judgeDist, { prefix: "/judge" });
  }
  await app.listen(config.port, "0.0.0.0");
  console.log(`Сервер соревнований слушает порт ${config.port}`);
}

void bootstrap();
