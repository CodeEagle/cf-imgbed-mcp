#!/usr/bin/env bash
# List Cloudflare Access service tokens.
set -euo pipefail
source "$(dirname "$0")/_lib.sh"

cf GET "/accounts/$ACCOUNT_ID/access/service_tokens" | jq -r '
  .result[] | [.id, .name, .client_id, .created_at, .expires_at // "never"] | @tsv' \
  | column -t -s $'\t' -N "ID,NAME,CLIENT_ID,CREATED,EXPIRES"
