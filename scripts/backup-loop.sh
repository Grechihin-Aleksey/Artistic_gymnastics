#!/bin/sh
# Работает внутри контейнера backup: снимает копию базы раз в BACKUP_INTERVAL секунд
# и хранит последние BACKUP_KEEP файлов. Копия пишется во временный файл и
# переименовывается только целиком, поэтому в папке не бывает оборванных копий.
set -u
INTERVAL="${BACKUP_INTERVAL:-300}"
KEEP="${BACKUP_KEEP:-288}"
DIR="${BACKUP_DIR:-/backups}"
mkdir -p "$DIR"

snapshot() {
  name="$DIR/gymnastics-$(date +%Y%m%d-%H%M%S).dump"
  if pg_dump --format=custom --file="$name.part"; then
    mv "$name.part" "$name"
    echo "резервная копия: $name"
  else
    rm -f "$name.part"
    echo "не удалось снять резервную копию" >&2
  fi
  ls -1t "$DIR"/gymnastics-*.dump 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f
}

if [ "${1:-}" = "once" ]; then
  snapshot
  exit 0
fi

while true; do
  snapshot
  sleep "$INTERVAL"
done
