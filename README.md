# Artistic Gymnastics

Система проведения соревнований по спортивной гимнастике: сервер в зале собирает оценки судей со страниц на снарядах, считает результаты по правилам FIG и в реальном времени передаёт их на сайт.

## Структура

| Пакет | Назначение |
| --- | --- |
| `packages/scoring` | Подсчёт по правилам FIG: оценка за выступление, опорный прыжок, многоборье, команды, места |

Дальше появятся `packages/shared`, `apps/server`, `apps/judge`, `apps/admin`, `apps/relay`, `apps/scoreboard`.

## Разработка

Нужны Node.js 22 и pnpm 10.

```sh
pnpm install
pnpm build
pnpm test
pnpm typecheck
```
