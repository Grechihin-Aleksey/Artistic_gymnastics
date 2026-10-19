# Artistic Gymnastics

Система проведения соревнований по спортивной гимнастике: сервер в зале собирает оценки судей со страниц на снарядах, считает результаты по правилам FIG и в реальном времени передаёт их на сайт.

## Структура

| Пакет | Назначение |
| --- | --- |
| `packages/scoring` | Подсчёт по правилам FIG: оценка за выступление, опорный прыжок, многоборье, команды, места |
| `packages/shared` | Схемы запросов и событий, общие для сервера и страниц |
| `apps/server` | Сервер в зале: участники, судьи, приём оценок, утверждение, результаты, Socket.IO |

Дальше появятся `apps/judge`, `apps/admin`, `apps/relay`, `apps/scoreboard`.

## Запуск сервера в зале

```sh
cp .env.example .env   # и впишите свой ADMIN_TOKEN
docker compose up -d
```

Сервер слушает порт 3000 и при старте сам применяет миграции базы. API описано в [apps/server/README.md](apps/server/README.md).

## Разработка

Нужны Node.js 22 и pnpm 10.

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test   # тестам сервера нужен PostgreSQL, адрес берётся из DATABASE_URL
```
