import type { NestExpressApplication } from "@nestjs/platform-express";

/** Общая настройка приложения для запуска и для тестов. */
export function configureApp(app: NestExpressApplication): void {
  // Логотип соревнования приходит картинкой в JSON: стандартных 100 КБ мало.
  app.useBodyParser("json", { limit: "6mb" });
}
