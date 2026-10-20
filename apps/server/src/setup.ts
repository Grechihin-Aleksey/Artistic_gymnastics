import type { NestExpressApplication } from "@nestjs/platform-express";
import { json } from "express";

/** Общая настройка приложения для запуска и для тестов. */
export function configureApp(app: NestExpressApplication): void {
  // Логотип соревнования приходит картинкой в JSON: стандартных 100 КБ мало.
  // Файл турнира со всеми оценками и журналом бывает больше.
  app.use("/competitions/import", json({ limit: "200mb" }));
  app.useBodyParser("json", { limit: "6mb" });
}
