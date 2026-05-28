#!/usr/bin/env bash
# Create a Cloudflare Access service token.
# Usage: scripts/token-create.sh <name> [duration]
#   duration: forever | 8760h | 720h (default: forever)
set -euo pipefail
source "$(dirname "$0")/_lib.sh"

NAME="${1:?usage: token-create.sh <name> [duration]}"
DUR="${2:-forever}"

BODY=$(jq -nc --arg n "$NAME" --arg d "$DUR" '{name:$n, duration:$d}')
RESP=$(cf POST "/accounts/$ACCOUNT_ID/access/service_tokens" "$BODY")

OK=$(echo "$RESP" | jq -r '.success')
if [[ "$OK" != "true" ]]; then
  echo "$RESP" | jq '.'
  exit 1
fi

TOKEN_ID=$(echo "$RESP" | jq -r '.result.id')

# Attach non-identity policy so this token passes Access on the app.
POL=$(jq -nc --arg n "token-$TOKEN_ID" --arg t "$TOKEN_ID" \
  '{name:$n, decision:"non_identity", include:[{service_token:{token_id:$t}}]}')
POL_RESP=$(cf POST "/accounts/$ACCOUNT_ID/access/apps/$ACCESS_APP_ID/policies" "$POL")
POL_OK=$(echo "$POL_RESP" | jq -r '.success')
if [[ "$POL_OK" != "true" ]]; then
  echo "WARNING: token created but policy attach failed:" >&2
  echo "$POL_RESP" | jq '.' >&2
fi

echo "$RESP" | jq '.'
echo
echo "---"
echo "Save these now (client_secret is shown ONCE):"
echo "$RESP" | jq -r '
  "  CF-Access-Client-Id:     " + .result.client_id,
  "  CF-Access-Client-Secret: " + .result.client_secret'
