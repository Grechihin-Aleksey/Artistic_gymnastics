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
mkdir -p backups video

# Собираем программу, только если её ещё нет или она изменилась (обновление): иначе интернет не нужен.
# REBUILD=1 scripts/start.sh — собрать заново в любом случае.
image=gymnastics-server:latest
stamp=$({ find apps/server apps/judge apps/scoreboard packages -type f -not -path '*/node_modules/*' -not -path '*/dist/*' 2>/dev/null
  printf '%s\n' package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json version.json .dockerignore; } | LC_ALL=C sort |
  while IFS= read -r f; do [ -f "$f" ] && printf '%s %s\n' "$f" "$(sha256sum <"$f" | cut -d' ' -f1)"; done | sha256sum | cut -d' ' -f1)
built=$(cat .build-stamp 2>/dev/null || true)
have_image=0; docker image inspect "$image" >/dev/null 2>&1 && have_image=1
online() { getent hosts registry-1.docker.io >/dev/null 2>&1 || nslookup registry-1.docker.io >/dev/null 2>&1; }
no_internet() {
  echo "Нет интернета, а программа на этом компьютере ещё не собрана." >&2
  echo "Подключите интернет и запустите снова, или скопируйте сюда папку offline с компьютера, где программа работает" >&2
  echo "(там: docker save -o offline/gymnastics-images.tar $image postgres:16-alpine && cp .build-stamp offline/stamp.txt)." >&2
}
if [ "${REBUILD:-0}" = 1 ] || [ "$have_image" = 0 ] || [ "$built" != "$stamp" ]; then
  if [ "${REBUILD:-0}" != 1 ] && [ -f offline/gymnastics-images.tar ] && [ "$(cat offline/stamp.txt 2>/dev/null)" = "$stamp" ]; then
    echo "Загружаю программу из папки offline (интернет не нужен)…"
    docker load -i offline/gymnastics-images.tar && cp offline/stamp.txt .build-stamp
  elif docker compose build server; then
    printf '%s' "$stamp" >.build-stamp
  elif [ "$have_image" = 1 ]; then
    echo "Новую версию собрать не удалось. Запускаю прежнюю версию программы." >&2
  elif [ -f offline/gymnastics-images.tar ]; then
    echo "Собрать программу не удалось. Запускаю версию из папки offline." >&2
    docker load -i offline/gymnastics-images.tar && cp offline/stamp.txt .build-stamp
  elif ! online; then
    no_internet; exit 1
  else
    echo "Сборка программы не удалась, причина выше." >&2; exit 1
  fi
fi
if ! docker compose up -d --no-build; then
  if ! docker image inspect postgres:16-alpine >/dev/null 2>&1 && ! online; then no_internet; fi
  exit 1
fi
# После обновления старые сборки программы остаются на диске и занимают сотни мегабайт: убираем их.
docker image prune -f >/dev/null 2>&1 || true
docker builder prune -f --filter until=168h >/dev/null 2>&1 || true

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

# Адрес в сети зала: тот, через который идёт основной маршрут, а не адрес моста Docker.
ip=$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit }}')
[ -n "$ip" ] || ip=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)
[ -n "$ip" ] || ip=localhost
token=$(sed -n 's/^ADMIN_TOKEN=//p' .env)
cat <<INFO

Сервер работает.
  Секретариат: http://$ip:3000/judge/#/admin
  Табло:       http://$ip:3000/board/
  Токен секретариата: $token
  (запасной ключ: им входят первый раз и если пароль забыт; пароль задайте в секретариате, «Пароль и вход»)
Резервные копии базы каждые 5 минут в папке backups.
Остановить: docker compose stop
INFO
