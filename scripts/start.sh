#!/usr/bin/env sh
# Unified launcher for all local deno task start* variants.
# Usage: start.sh [--net|--unsafe] [-- app args...]
#
# --net    broad --allow-net, loads ssl+pyodide-http (like start:net)
# --unsafe --allow-all + Python host-exec unblocked (like start:unsafe)
# (none)   scoped --allow-net, host auto-added from OPENAI_BASE_URL
set -e

ALLOW_ENV="OPENAI_*,MODEL,MAX_ITERATIONS,PYODIDE_PACKAGES,HTTP_PROXY,HTTPS_PROXY,NO_PROXY"
MODE="default"
case "${1:-}" in
  --net)    MODE="net";    shift ;;
  --unsafe) MODE="unsafe"; shift ;;
esac

case "$MODE" in
  net)
    exec deno run \
      --env-file=.env \
      "--allow-env=${ALLOW_ENV}" \
      --allow-read --allow-write --allow-net --allow-import \
      src/main.ts --allow-net "$@"
    ;;
  unsafe)
    exec deno run \
      --env-file=.env \
      --allow-all \
      src/main.ts --allow-net --allow-host-exec "$@"
    ;;
  *)
    BASE_URL="${OPENAI_BASE_URL:-}"
    if [ -z "$BASE_URL" ] && [ -f .env ]; then
      BASE_URL=$(grep -E '^OPENAI_BASE_URL=' .env 2>/dev/null | head -1 | cut -d= -f2-)
      BASE_URL=$(echo "$BASE_URL" | sed "s/^['\"]//; s/['\"]$//")
    fi
    ALLOW_NET="api.openai.com,cdn.jsdelivr.net"
    if [ -n "$BASE_URL" ]; then
      HOST=$(echo "$BASE_URL" | sed -E 's|^https?://([^/:?#]*).*|\1|')
      if [ -n "$HOST" ]; then
        case ",$ALLOW_NET," in
          *",$HOST,"*) ;;
          *) ALLOW_NET="${ALLOW_NET},$HOST" ;;
        esac
      fi
    fi
    exec deno run \
      --env-file=.env \
      "--allow-env=${ALLOW_ENV}" \
      --allow-read --allow-write \
      "--allow-net=${ALLOW_NET}" \
      --allow-import=cdn.jsdelivr.net,jsr.io \
      src/main.ts "$@"
    ;;
esac
