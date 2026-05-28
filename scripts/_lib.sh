#!/usr/bin/env bash
# Common helpers for token scripts.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

if [[ -f "$ROOT/.env" ]]; then
  set -a; source "$ROOT/.env"; set +a
fi

: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN in .env}"

# These can be overridden via .env if you want. Defaults match the deployed app.
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID in .env}"
: "${ACCESS_APP_ID:?set ACCESS_APP_ID in .env (the Access self-hosted app id)}"
ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID"
export ACCESS_APP_ID

API="https://api.cloudflare.com/client/v4"

cf() {
  local method="$1"; shift
  local path="$1"; shift
  local data="${1:-}"
  if [[ -n "$data" ]]; then
    curl -sS -X "$method" "$API$path" \
      -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
      -H "Content-Type: application/json" \
      --data "$data"
  else
    curl -sS -X "$method" "$API$path" \
      -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
  fi
}
