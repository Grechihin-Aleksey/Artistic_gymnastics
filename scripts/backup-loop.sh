#!/bin/sh
# Работает внутри контейнера backup: снимает копию базы раз в BACKUP_INTERVAL секунд
# и хранит последние BACKUP_KEEP файлов. Копия пишется во временный файл и
# переименовывается только целиком, поэтому в папке не бывает оборванных копий.
#
# Раз в RESTORE_CHECK_INTERVAL секунд (по умолчанию раз в сутки и сразу при запуске)
# самая свежая копия пробно разворачивается в отдельную временную базу: так видно,
# что из копий действительно можно восстановиться. Итог пишется в restore-check.json,
# его показывает «Готовность к старту».
#
# Пока в базе ничего не меняется (между турнирами), новая копия не снимается: у самой
# свежей только обновляется время, поэтому имя файла показывает время последнего
# изменения. По нему программа понимает, что турнир давно закончился, и через
# заданный в секретариате срок убирает лишние копии (блок «Очистка после турниров»).
#
# Если на диске остаётся меньше MIN_FREE_MB мегабайт, самые старые копии удаляются
# раньше срока (свежие BACKUP_MIN_KEEP остаются всегда).
set -u
INTERVAL="${BACKUP_INTERVAL:-300}"
KEEP="${BACKUP_KEEP:-288}"
MIN_KEEP="${BACKUP_MIN_KEEP:-12}"
MIN_FREE_MB="${MIN_FREE_MB:-2048}"
CHECK_INTERVAL="${RESTORE_CHECK_INTERVAL:-86400}"
DIR="${BACKUP_DIR:-/backups}"
CHECK_FILE="$DIR/restore-check.json"
CHECK_DB="gymnastics_restore_check"
mkdir -p "$DIR"

free_mb() {
  df -Pk "$DIR" 2>/dev/null | awk 'NR == 2 { print int($4 / 1024) }'
}

# Место кончается: убираем старые копии, пока не освободится MIN_FREE_MB или не останется MIN_KEEP.
free_space() {
  while :; do
    free="$(free_mb)"
    [ -n "$free" ] && [ "$free" -lt "$MIN_FREE_MB" ] || return 0
    count="$(ls -1 "$DIR"/gymnastics-*.dump 2>/dev/null | wc -l)"
    [ "$count" -gt "$MIN_KEEP" ] || return 0
    oldest="$(ls -1t "$DIR"/gymnastics-*.dump | tail -n 1)"
    echo "мало места на диске (${free} МБ): удаляю старую копию $oldest" >&2
    rm -f "$oldest"
  done
}

# Счётчик всех записей в базе: не изменился — значит, и копия не нужна.
fingerprint() {
  psql -tAc "select coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0) || '/' || coalesce(sum(n_live_tup), 0) from pg_stat_user_tables" 2>/dev/null
}
last_print=""

snapshot() {
  print="$(fingerprint)"
  newest="$(ls -1t "$DIR"/gymnastics-*.dump 2>/dev/null | head -n 1)"
  if [ -n "$print" ] && [ "$print" = "$last_print" ] && [ -n "$newest" ]; then
    touch "$newest"
    return 0
  fi
  name="$DIR/gymnastics-$(date +%Y%m%d-%H%M%S).dump"
  if pg_dump --format=custom --file="$name.part"; then
    mv "$name.part" "$name"
    last_print="$print"
    echo "резервная копия: $name"
  else
    rm -f "$name.part"
    echo "не удалось снять резервную копию" >&2
  fi
  ls -1t "$DIR"/gymnastics-*.dump 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f
  free_space
}

# Текст для JSON: одна строка, без кавычек и обратных косых.
json_text() {
  tr '\n\r\t"\\' '     ' | cut -c1-300
}

write_check() {
  printf '%s\n' "$1" >"$CHECK_FILE.part" && mv "$CHECK_FILE.part" "$CHECK_FILE"
}

# Пробное восстановление свежей копии во временную базу; рабочая база не трогается.
restore_check() {
  latest="$(ls -1t "$DIR"/gymnastics-*.dump 2>/dev/null | head -n 1)"
  [ -n "$latest" ] || return 0
  at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  file="$(basename "$latest")"
  log="$(mktemp)"
  dropdb --if-exists "$CHECK_DB" >/dev/null 2>&1
  if createdb "$CHECK_DB" 2>"$log" &&
    pg_restore --no-owner --exit-on-error --dbname="$CHECK_DB" "$latest" 2>"$log" &&
    count="$(psql --dbname="$CHECK_DB" -tAc 'select count(*) from competitions' 2>"$log")"; then
    write_check "{\"ok\":true,\"at\":\"$at\",\"file\":\"$file\",\"competitions\":$count}"
    echo "проверка восстановления: копия $file развёрнута, турниров $count"
  else
    error="$(head -n 3 "$log" | json_text)"
    write_check "{\"ok\":false,\"at\":\"$at\",\"file\":\"$file\",\"error\":\"${error:-неизвестная ошибка}\"}"
    echo "проверка восстановления не прошла: $file: $error" >&2
  fi
  dropdb --if-exists "$CHECK_DB" >/dev/null 2>&1
  rm -f "$log"
}

if [ "${1:-}" = "once" ]; then
  snapshot
  exit 0
fi

if [ "${1:-}" = "check" ]; then
  restore_check
  exit 0
fi

last_check=0
while true; do
  snapshot
  now="$(date +%s)"
  if [ "$CHECK_INTERVAL" -gt 0 ] && [ $((now - last_check)) -ge "$CHECK_INTERVAL" ]; then
    restore_check
    last_check="$now"
  fi
  sleep "$INTERVAL"
done
