# Готовые файлы для скачивания

`ag-relay-php.zip` — ретранслятор результатов для обычного PHP-хостинга (Beget и подобные). Распакуйте папку `results` в `public_html` сайта и впишите токен в `results/config.php`. Пошагово — в разделе «Ретранслятор» файла `apps/relay/README.md`.

`ag-results-wordpress.zip` — плагин WordPress «Табло результатов»: табло вставляется на страницу шорткодом `[ag_results id="…"]`, а кнопка «Подать заявку» для клубов — шорткодом `[ag_entry id="…" key="…"]`, и это может сделать редактор без прав администратора. Установка: «Плагины → Добавить новый → Загрузить плагин». Подробнее — в разделе «Плагин WordPress» файла `apps/relay/README.md`.

Архивы собираются командой `pnpm --filter @ag/scoreboard build && pnpm --filter @ag/relay build:php` и копируются сюда из `apps/relay/dist-php/`.
