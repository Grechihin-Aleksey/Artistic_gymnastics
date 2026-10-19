# Сервер в зале

NestJS, PostgreSQL (Drizzle ORM), Socket.IO. Все оценки хранятся в тысячных долях балла, в API передаются обычными числами (`8.7`).

## Доступ

Запросы с изменениями требуют заголовок `Authorization: Bearer <токен>`.

- **Секретариат** — токен из переменной `ADMIN_TOKEN`.
- **Судья** — токен, который выдаётся один раз при создании судьи (`POST /competitions/:id/judges`). Его удобно передать на планшет QR-кодом.
- Результаты и списки участников открыты без токена: их читают табло и ретранслятор для сайта.

## API

| Метод | Путь | Кто | Что делает |
| --- | --- | --- | --- |
| POST | `/competitions` | секретариат | Создать соревнование (`MAG` или `WAG`, формат команд) |
| GET | `/competitions`, `/competitions/:id` | все | Список и карточка |
| POST, GET | `/competitions/:id/teams` | секретариат / все | Команды |
| POST, GET | `/competitions/:id/gymnasts` | секретариат / все | Участники |
| POST, GET | `/competitions/:id/judges` | секретариат | Судьи; POST возвращает токен |
| POST | `/judges/:id/token` | секретариат | Новый токен судьи взамен потерянного |
| GET | `/me` | судья | Кто я: судья и соревнование |
| POST | `/competitions/:id/performances` | секретариат | Вызвать участника на снаряд (для прыжка — `attempt` 1 или 2) |
| GET | `/competitions/:id/performances?apparatus=BB` | секретариат, судьи | Выступления с оценками |
| POST | `/marks` | судья | Оценка: `{ id, performanceId, kind: D/E/NEUTRAL, value }` |
| POST | `/performances/:id/approve` | старший судья снаряда, секретариат | Посчитать и утвердить итог |
| POST | `/performances/:id/reopen` | секретариат | Вернуть на правку с причиной |
| GET | `/competitions/:id/results/live` | все | Для табло: кто выступает на каждом снаряде и последняя оценка |
| GET | `/competitions/:id/results/apparatus/:apparatus?vault=average` | все | Места на снаряде |
| GET | `/competitions/:id/results/all-around` | все | Многоборье |
| GET | `/competitions/:id/results/teams` | все | Командный зачёт |

Правила оценок:
- судья E ставит сумму сбавок `E`, судья D и старший судья — `D` и `NEUTRAL`;
- `id` оценки создаёт планшет, поэтому повторная отправка после обрыва связи не создаёт дубль; новая оценка того же судьи заменяет прежнюю и пишется в журнал;
- утвердить можно, когда есть D (у всех судей D одинаковая) и пришли оценки всех судей E бригады.

Если заданы переменные `JUDGE_DIST` и `BOARD_DIST` (или рядом лежат сборки `apps/judge/dist` и `apps/scoreboard/dist`), сервер раздаёт страницы судей по адресу `/judge/` и табло по адресу `/board/`.

## Socket.IO

Пространство `/live`, события в `@ag/shared` (`LIVE_EVENTS`).

- Табло и ретранслятор: `emit("competition.join", { competitionId })`, затем слушают `performance.called`, `performance.approved`, `performance.reopened`. Оценки отдельных судей в этих событиях есть, только если соревнование создано с `publishJudgeMarks: true`.
- Судья подключается с `auth: { token }` и дополнительно получает `performance.marks` по своему снаряду.

## Разработка

```sh
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/ag_test
pnpm --filter @ag/server test
pnpm --filter @ag/server db:generate   # после изменения src/db/schema.ts
```
