#!/usr/bin/env bash
# Delete (revoke) a Cloudflare Access service token by id.
# Usage: scripts/token-delete.sh <token_id>
set -euo pipefail
source "$(dirname "$0")/_lib.sh"

ID="${1:?usage: token-delete.sh <token_id>}"

# Find + delete the matching policy (named token-<id>) first.
POL_ID=$(cf GET "/accounts/$ACCOUNT_ID/access/apps/$ACCESS_APP_ID/policies" \
  | jq -r --arg n "token-$ID" '.result[] | select(.name == $n) | .id' | head -n1)

if [[ -n "$POL_ID" ]]; then
  echo "removing policy $POL_ID"
  cf DELETE "/accounts/$ACCOUNT_ID/access/apps/$ACCESS_APP_ID/policies/$POL_ID" | jq -c '.success'
fi

cf DELETE "/accounts/$ACCOUNT_ID/access/service_tokens/$ID" | jq '.'
