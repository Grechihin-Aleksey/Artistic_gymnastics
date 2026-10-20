#!/bin/sh
# Восстановление базы из резервной копии (Linux, macOS).
#   scripts/restore.sh                       — из самой свежей копии в папке backups
#   scripts/restore.sh backups/имя-файла.dump — из выбранной
# Текущие данные в базе заменяются данными из копии.
set -eu
cd "$(dirname "$0")/.."

file="${1:-$(ls -1t backups/gymnastics-*.dump 2>/dev/null | head -n 1)}"
if [ -z "$file" ] || [ ! -f "$file" ]; then
  echo "Не найдена резервная копия. Укажите файл: scripts/restore.sh backups/имя.dump" >&2
  exit 1
fi
echo "Восстанавливаю базу из $file"
printf "Текущие данные будут заменены. Продолжить? [y/N] "
read -r answer
[ "$answer" = "y" ] || [ "$answer" = "Y" ] || exit 1

docker compose up -d db
docker compose stop server backup
docker compose exec -T db pg_restore --clean --if-exists --no-owner -U gymnastics -d gymnastics <"$file"
docker compose up -d server backup
echo "Готово: база восстановлена, сервер запущен."
