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
| POST | `/performances/:id/inquiries` | секретариат | Запрос тренера на пересмотр D: `{ coach, claimedD? }`. Только на утверждённую оценку, один нерассмотренный на выступление. Подан после показа следующей оценки на снаряде или позже 4 минут — помечается `late` |
| GET | `/competitions/:id/inquiries` | секретариат | Все запросы соревнования |
| POST | `/inquiries/:id/resolve` | секретариат | Решение жюри: `{ decision: "accept", d, note? }` меняет D и итог, оценка заново уходит на табло и сайт; `{ decision: "reject", note? }` оставляет как есть |
| GET | `/competitions/:id/protocols/apparatus/:apparatus` | секретариат | Протокол снаряда в PDF: D, сбавки каждого судьи E (крайние в скобках), E, нейтральные сбавки, итог; у прыжка обе попытки; `?stage=final` — протокол финала |
| GET | `/competitions/:id/protocols/all-around` | секретариат | Протокол многоборья в PDF |
| GET | `/competitions/:id/protocols/teams` | секретариат | Командный протокол в PDF с оценками участников, не вошедшие в зачёт — в скобках |
| | | | Протоколы выше принимают `?category=<id>` (или `none` — участники без разряда) |
| GET | `/competitions/:id/protocols/start-list` | секретариат | Стартовый протокол в PDF: порядок ротаций и смены в порядке выхода |
| GET | `/competitions/:id/protocols/sheet/:apparatus` | секретариат | Судейская ведомость снаряда в PDF: участники по ротациям и пустые графы для оценок; `?stage=final` — финалисты в порядке выступления и запасные |
| GET | `/competitions/:id/protocols/earned` | секретариат | Выполнившие разряды в PDF: по уровням, с датой рождения, клубом, тренером |
| GET | `/competitions/:id/protocols/bibs` | секретариат | Нагрудные номера в PDF, по два на лист A4 |
| GET | `/competitions/:id/protocols/officials` | секретариат | Состав судейской коллегии в PDF |
| GET | `/competitions/:id/protocols/clubs` | секретариат | Протокол общекомандного зачёта в PDF |
| GET | `/competitions/:id/protocols/audit?group=` | секретариат | Журнал изменений в PDF по порядку времени; `group` — `marks`, `inquiries`, `roster` или `setup` |
| GET | `/competitions/:id/protocols/audit.xlsx?group=` | секретариат | Журнал изменений в Excel |
| GET | `/competitions/:id/protocols/report` | секретариат | Итоговый отчёт в PDF: участники, клубы, призёры, разряды, судьи |
| GET | `/competitions/:id/protocols/results.xlsx` | секретариат | Итоги в Excel: по каждому разряду многоборье, снаряды и команды |
| GET | `/competitions/:id/protocols/diplomas` | секретариат | Грамоты призёрам в PDF: `?kind=all-around` (многоборье и команды) или `apparatus`, `?places=3` |
| PATCH | `/competitions/:id/gymnasts/:gymnastId` | секретариат | Правка участника: номер, фамилия, имя, отчество, дата рождения, клуб, город, тренер, команда, разряд, смена, статус (`ACTIVE`, `DNS` — неявка, `WITHDRAWN` — снятие) |
| GET | `/competitions/:id/normatives` | все | Нормативы разрядов: уровни и минимальная сумма многоборья по каждому разряду |
| GET | `/competitions/:id/audit?group=` | секретариат | Журнал изменений, новые сверху: время, кто (секретариат или судья), снаряд, участник и что произошло понятным текстом |
| PUT | `/competitions/:id/ceremony` | секретариат | Вывести награждение на табло: `{ ceremony: { kind: "allAround" \| "apparatus" \| "teams" \| "clubs", categoryId, apparatus? } }` или убрать его (`{ ceremony: null }`); отвечает пьедесталом, табло получает событие `competition.ceremony`, пьедестал приходит в снимке (`ceremony`) |
| PUT | `/competitions/:id/club-standing` | секретариат | Очки общекомандного зачёта: `{ allAround: [10, 8, 6], apparatus: [...], teams: [...], best: 3 \| null }` — очки за места по порядку и сколько лучших от клуба в разряде идут в зачёт многоборья |
| PUT | `/competitions/:id/normatives` | секретариат | Задать нормативы: `{ categories: [{ categoryId, levels: [{ name, min }] }] }` |
| PUT | `/competitions/:id/officials` | секретариат | Главный судья и главный секретарь: `{ chiefJudge, chiefSecretary }`, у каждого `{ name, category?, city? }` или `null` |
| GET | `/competitions/:id/finals` | все | Финалы на снарядах: этап (`QUAL`/`FINAL`), параметры отбора, финалисты по снарядам и разрядам в порядке выступления, запасные |
| POST | `/competitions/:id/finals` | секретариат | Сформировать финалы по квалификации: `{ size, reserves, perClub }`; пока нет финальных оценок, можно пересобрать |
| POST | `/competitions/:id/finals/phase` | секретариат | Переключить этап: `{ phase: "QUAL" \| "FINAL" }`; в финалах вызывают только финалистов |
| POST | `/competitions/:id/finals/:apparatus/replace` | секретариат | Финалист снимается до выступления, его место занимает первый запасной: `{ gymnastId }` |
| DELETE | `/competitions/:id/gymnasts/:gymnastId` | секретариат | Удалить участника, который ещё не выступал |
| POST | `/competitions/:id/draw` | секретариат | Жеребьёвка до первых оценок: `{ mode: "random", firstBib, keepTeams }` или `{ mode: "manual", bibs: [{ gymnastId, bib }] }` |
| GET | `/competitions/:id/draw` | секретариат | Идут ли уже оценки и когда была последняя жеребьёвка |
| GET | `/competitions/:id/rules` | все | Правила судейства: FIG или свои, базы разрядов, список сбавок за требования |
| PUT | `/competitions/:id/rules` | секретариат | Задать правила: `{ rules, deductions: [{ name, value }], bases: [{ categoryId, base, apparatus }] }` |
| POST | `/competitions/:id/gymnasts/parse-xlsx` | секретариат | Заявка Excel (`{ file }` в base64) → текст списка для проверки перед импортом |
| GET | `/competitions/:id/entries-template.xlsx` | все | Бланк заявки для клубов |
| PUT | `/competitions/:id/logo` | секретариат | Логотип для шапки протоколов: `{ dataUrl }`, PNG или JPEG |
| DELETE | `/competitions/:id/logo` | секретариат | Убрать логотип |
| GET | `/competitions/:id/logo` | все | Сам логотип картинкой |
| GET | `/competitions/:id/rotation` | все | Смены в текущей ротации |
| POST | `/competitions/:id/rotation` | секретариат | Перевести на ротацию `{ rotation }` (с нуля) |
| PUT | `/competitions/:id/shifts/:number` | секретариат | Стартовый снаряд смены `{ startApparatus }` |
| POST | `/performances/:id/tablet-score` | планшет снаряда | Оценки всей бригады `{ d, e[], neutral? }` и утверждение |
| GET | `/competitions/:id/results/snapshot` | все | Всё для табло одним ответом: «сейчас», многоборье, команды, снаряды. Этот же снимок уходит на сайт |
| GET | `/competitions/:id/results/apparatus/:apparatus?vault=average` | все | Места на снаряде; `?stage=final` — в финале |
| GET | `/competitions/:id/results/all-around` | все | Многоборье |
| GET | `/competitions/:id/results/teams` | все | Командный зачёт |
| GET | `/competitions/:id/results/clubs` | все | Общекомандный зачёт клубов: очки за многоборье, снаряды и команды, число призовых мест |

Правила оценок:
- судья E ставит сумму сбавок `E`, судья D и старший судья — `D` и `NEUTRAL`;
- `id` оценки создаёт планшет, поэтому повторная отправка после обрыва связи не создаёт дубль; новая оценка того же судьи заменяет прежнюю и пишется в журнал;
- утвердить можно, когда есть D (у всех судей D одинаковая) и пришли оценки всех судей E бригады.

Если заданы переменные `JUDGE_DIST` и `BOARD_DIST` (или рядом лежат сборки `apps/judge/dist` и `apps/scoreboard/dist`), сервер раздаёт страницы судей по адресу `/judge/` и табло по адресу `/board/`.

Если заданы `RELAY_URL` и `RELAY_TOKEN`, после каждого вызова участника, утверждения и возврата оценки сервер отправляет снимок результатов на облачный ретранслятор (`POST <RELAY_URL>/ingest/:id`). При обрыве связи отправка повторяется с нарастающей паузой до минуты, в очереди хранится только последний снимок. Раз в пять минут сервер повторяет снимки всех соревнований, которые уже отправлял.

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
