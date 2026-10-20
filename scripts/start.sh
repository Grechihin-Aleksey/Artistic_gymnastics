#!/bin/sh
# Запуск сервера в зале одной командой (Linux, macOS). Нужен Docker.
# При первом запуске создаёт .env с токеном секретариата.
set -eu
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  token=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24)
  sed "s/^ADMIN_TOKEN=.*/ADMIN_TOKEN=$token/" .env.example >.env
  echo "Создан файл .env с новым токеном секретариата."
fi
mkdir -p backups

docker compose up -d --build

printf "Жду, пока сервер запустится"
i=0
until curl -fsS http://localhost:3000/competitions >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 90 ]; then
    echo
    echo "Сервер не ответил за 3 минуты. Журнал: docker compose logs server" >&2
    exit 1
  fi
  printf "."
  sleep 2
done
echo

ip=$( (hostname -I 2>/dev/null || ipconfig getifaddr en0 2>/dev/null || echo localhost) | awk '{print $1}')
token=$(sed -n 's/^ADMIN_TOKEN=//p' .env)
cat <<INFO

Сервер работает.
  Секретариат: http://$ip:3000/judge/#/admin
  Табло:       http://$ip:3000/board/
  Токен секретариата: $token
Резервные копии базы каждые 5 минут в папке backups.
Остановить: docker compose stop
INFO
