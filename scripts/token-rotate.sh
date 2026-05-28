#!/usr/bin/env bash
# Rotate a service token's secret (id stays, secret refreshed once).
# Usage: scripts/token-rotate.sh <token_id>
set -euo pipefail
source "$(dirname "$0")/_lib.sh"

ID="${1:?usage: token-rotate.sh <token_id>}"
RESP=$(cf POST "/accounts/$ACCOUNT_ID/access/service_tokens/$ID/rotate")
echo "$RESP" | jq '.'
echo
echo "---"
echo "New secret (shown ONCE):"
echo "$RESP" | jq -r '
  "  CF-Access-Client-Id:     " + .result.client_id,
  "  CF-Access-Client-Secret: " + .result.client_secret'
