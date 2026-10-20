# Готовые файлы для скачивания

`ag-relay-php.zip` — ретранслятор результатов для обычного PHP-хостинга (Beget и подобные). Распакуйте папку `results` в `public_html` сайта и впишите токен в `results/config.php`. Пошагово — в разделе «Ретранслятор» файла `apps/relay/README.md`.

Архив собирается командой `pnpm --filter @ag/scoreboard build && pnpm --filter @ag/relay build:php` и копируется сюда из `apps/relay/dist-php/`.
