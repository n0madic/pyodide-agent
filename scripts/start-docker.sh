#!/usr/bin/env sh
# Docker variant: env vars come in via `docker run -e`, not .env file.
# Same dynamic --allow-net logic as start.sh.
set -e

ALLOW_ENV="OPENAI_*,MODEL,MAX_ITERATIONS,PYODIDE_PACKAGES,HTTP_PROXY,HTTPS_PROXY,NO_PROXY"
ALLOW_NET="api.openai.com,cdn.jsdelivr.net"
if [ -n "${OPENAI_BASE_URL:-}" ]; then
  HOST=$(echo "$OPENAI_BASE_URL" | sed -E 's|^https?://([^/:?#]*).*|\1|')
  if [ -n "$HOST" ]; then
    case ",$ALLOW_NET," in
      *",$HOST,"*) ;;
      *) ALLOW_NET="${ALLOW_NET},$HOST" ;;
    esac
  fi
fi

exec deno run \
  "--allow-env=${ALLOW_ENV}" \
  --allow-read \
  --allow-write \
  "--allow-net=${ALLOW_NET}" \
  --allow-import=cdn.jsdelivr.net,jsr.io \
  /home/agent/app/src/main.ts \
  "$@"
