#!/bin/sh
# Поднимает превью. Если кабинет уже отвечает — ничего не перезапускает.
# Короткий запрос к боту включает приём /start, пока кабинет не опубликован.
set -e
cd /workspace
if curl -sf -o /dev/null --max-time 2 http://127.0.0.1:8080/; then
  curl -sf -o /dev/null --max-time 5 http://127.0.0.1:8080/api/telegram || true
  exit 0
fi
npm run dev > /tmp/pvz-dev.log 2>&1 &
i=0
while [ "$i" -lt 40 ]; do
  if curl -sf -o /dev/null --max-time 1 http://127.0.0.1:8080/; then
    curl -sf -o /dev/null --max-time 5 http://127.0.0.1:8080/api/telegram || true
    exit 0
  fi
  i=$((i + 1))
  sleep 1
done
echo "dev server did not start" >&2
exit 1
