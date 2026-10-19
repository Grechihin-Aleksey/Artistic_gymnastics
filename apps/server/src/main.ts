import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { loadConfig } from "./config";

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule.forConfig(config), { cors: true });
  app.enableShutdownHooks();
  await app.listen(config.port, "0.0.0.0");
  console.log(`Сервер соревнований слушает порт ${config.port}`);
}

void bootstrap();
