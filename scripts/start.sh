#!/usr/bin/env sh
# Unified launcher for all deno task start* variants (local + Docker).
# Usage: start.sh [--net|--unsafe] [app args...]
#
# --net    broad --allow-net, loads ssl+pyodide-http
# --unsafe --allow-all + Python host-exec unblocked
# (none)   scoped --allow-net, OPENAI_BASE_URL host auto-added
#
# Paths are resolved relative to this script so it works both locally
# (scripts/start.sh → src/main.ts) and in Docker (/home/agent/app/scripts/ →
# /home/agent/app/src/main.ts). --env-file is added only when .env exists.
set -e

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_DIR=$(cd "${SCRIPT_DIR}/.." && pwd)
MAIN_TS="${PROJECT_DIR}/src/main.ts"
ENV_FILE="${PROJECT_DIR}/.env"

MODE="default"
case "${1:-}" in
  --net)    MODE="net";    shift ;;
  --unsafe) MODE="unsafe"; shift ;;
esac

# --env-file flag — omitted in Docker where .env is not in the image
ENV_FLAG=""
[ -f "$ENV_FILE" ] && ENV_FLAG="--env-file=${ENV_FILE}"

case "$MODE" in
  net)
    # shellcheck disable=SC2086
    exec deno run \
      $ENV_FLAG \
      --allow-env="*" \
      --allow-read --allow-write --allow-net --allow-import \
      "$MAIN_TS" --allow-net "$@"
    ;;
  unsafe)
    # shellcheck disable=SC2086
    exec deno run \
      $ENV_FLAG \
      --allow-all \
      "$MAIN_TS" --allow-net --allow-host-exec "$@"
    ;;
  *)
    BASE_URL="${OPENAI_BASE_URL:-}"
    if [ -z "$BASE_URL" ] && [ -f "$ENV_FILE" ]; then
      BASE_URL=$(grep -E '^OPENAI_BASE_URL=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-)
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
    # shellcheck disable=SC2086
    exec deno run \
      $ENV_FLAG \
      --allow-env="*" \
      --allow-read --allow-write \
      "--allow-net=${ALLOW_NET}" \
      --allow-import=cdn.jsdelivr.net,jsr.io \
      "$MAIN_TS" "$@"
    ;;
esac
