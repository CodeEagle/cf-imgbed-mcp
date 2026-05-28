# cf-imgbed MCP — Usage Guide (for agents)

A Cloudflare Workers–hosted image-bed exposed as a Model Context Protocol server.
Upload images, get permanent public URLs, list / inspect / delete.

- **MCP endpoint**: `https://img.selfstudio.fun/mcp`
- **Transport**: Streamable HTTP (single endpoint, all methods)
- **Auth**: Cloudflare Access service token (header-based)
- **Storage**: Cloudflare R2 (S3-backed object storage)
- **Public delivery**: `https://img.selfstudio.fun/img/<key>` — no auth, CDN cached `immutable, max-age=31536000`

---

## 1. Auth

Every MCP request must carry two headers issued by the image-bed owner:

```
CF-Access-Client-Id:     <id>.access
CF-Access-Client-Secret: <secret-hex-64>
```

Get a token from the owner (or via owner's CLI):

```bash
# owner runs:
scripts/token-create.sh agent-<name>
# or:
curl -X POST https://img.selfstudio.fun/api/tokens \
  -H "CF-Access-Client-Id: <owner-id>" \
  -H "CF-Access-Client-Secret: <owner-secret>" \
  -H "content-type: application/json" \
  -d '{"name":"agent-<name>","duration":"forever"}'
```

Each agent **must use its own token** (revoke individually, audit by name).

To revoke:

```bash
scripts/token-delete.sh <token_id>
# or:
curl -X DELETE https://img.selfstudio.fun/api/tokens/<id> -H "CF-Access-Client-Id: ..." -H "CF-Access-Client-Secret: ..."
```

---

## 2. MCP client config

### Claude Code / generic Streamable-HTTP MCP client

```json
{
  "mcpServers": {
    "imgbed": {
      "type": "http",
      "url": "https://img.selfstudio.fun/mcp",
      "headers": {
        "CF-Access-Client-Id": "REPLACE_WITH_CLIENT_ID",
        "CF-Access-Client-Secret": "REPLACE_WITH_CLIENT_SECRET"
      }
    }
  }
}
```

### Codex / OpenAI-style

```toml
[mcp_servers.imgbed]
transport = "http"
url       = "https://img.selfstudio.fun/mcp"

[mcp_servers.imgbed.headers]
"CF-Access-Client-Id"     = "REPLACE_WITH_CLIENT_ID"
"CF-Access-Client-Secret" = "REPLACE_WITH_CLIENT_SECRET"
```

If your client doesn't support custom headers natively, put it behind a `mcp-proxy` or `cloudflared` wrapper.

---

## 3. Tools

All tool results are returned as `content: [{ type: "text", text: <JSON string> }]`.

### 3.1 `upload_image`

Upload an image. Provide **either** `url` **or** (`base64` + `content_type`).

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `url` | string (URL) | one-of | Fetch image from this URL and upload as-is |
| `base64` | string | one-of | Raw base64 (no `data:` prefix) |
| `content_type` | string | with `base64` | e.g. `image/png`, `image/jpeg` |

**Response** (JSON in text):

```json
{
  "key": "202605/51cb6622a1ea0e8b.png",
  "url": "https://img.selfstudio.fun/img/202605/51cb6622a1ea0e8b.png",
  "size": 68,
  "contentType": "image/png",
  "etag": "cc0f5cff61d19e1a8aa6afd9ec621555",
  "uploaded": "2026-05-28T04:18:57.554Z"
}
```

The returned `url` is the **permanent public direct link**. Use it in markdown, HTML, replies — no auth needed.

**Examples**:

```jsonc
// Pull a remote image and rehost
{ "tool": "upload_image", "args": { "url": "https://example.com/photo.jpg" } }

// Push a locally generated PNG (base64-encoded)
{
  "tool": "upload_image",
  "args": {
    "base64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAA...",
    "content_type": "image/png"
  }
}
```

### 3.2 `list_images`

List objects in the bucket, paginated.

| Field | Type | Default |
|-------|------|---------|
| `prefix` | string | _(none)_ |
| `cursor` | string | _(none)_ |
| `limit` | int 1–1000 | 100 |

**Response**:

```json
{
  "items": [
    {
      "key": "202605/51cb6622a1ea0e8b.png",
      "url": "https://img.selfstudio.fun/img/202605/51cb6622a1ea0e8b.png",
      "size": 68,
      "contentType": "image/png",
      "uploaded": "2026-05-28T04:18:57.554Z",
      "etag": "cc0f5cff61d19e1a8aa6afd9ec621555"
    }
  ],
  "truncated": false,
  "cursor": null
}
```

When `truncated: true`, pass `cursor` from response into the next call.

### 3.3 `get_image_info`

| Field | Type | Required |
|-------|------|----------|
| `key` | string | yes |

**Response**: same shape as one `list_images.items[]` entry, plus `customMetadata`.
Returns `isError: true` with text `"not found: <key>"` if missing.

### 3.4 `delete_image`

| Field | Type | Required |
|-------|------|----------|
| `key` | string | yes |

**Response**: text `"deleted <key>"`.

---

## 4. Behaviour & constraints

- **MIME whitelist**: `image/png`, `image/jpeg`, `image/webp`, `image/gif`, `image/avif`, `image/svg+xml`, `image/bmp`, `image/x-icon`. Anything else → `415 unsupported content-type`.
- **Max upload**: 25 MiB per file (`MAX_UPLOAD_BYTES=26214400`). Larger → `413 file too large`.
- **Content-addressed keys**: `YYYYMM/<sha256[:16]>.<ext>`. Same bytes → same key → **automatic dedupe**. Re-upload is a cheap no-op that returns the existing entry.
- **Public URL is immutable**: once a key is created, its bytes never change. Safe to embed permanently. (Delete only invalidates fetch of that key.)
- **Strip `data:` prefix from base64**: `iVBORw0KGgo...` not `data:image/png;base64,iVBORw0KGgo...`.
- **Errors** are returned with non-200 status from the underlying HTTP API; MCP wraps them as tool errors with the upstream message.

---

## 5. System-prompt snippet for the consuming agent

Paste into the downstream agent's system prompt so it knows when/how to use:

```
You have an MCP tool group named `imgbed` for uploading and managing images.

When to use:
- User shares an image URL and asks you to archive it / rehost it / use it later.
  → upload_image(url=<their url>)
- You generate or edit an image and need a public link to embed in markdown/HTML.
  → upload_image(base64=<bytes>, content_type=<mime>)
- The user asks "what images have we uploaded?" or wants to clean up.
  → list_images, then delete_image as needed.

Important:
- The `url` field in upload_image response is a permanent public direct link.
  Use it verbatim in markdown image syntax: ![alt](https://img.selfstudio.fun/img/<key>)
- Re-uploading the same bytes is free (content-addressed dedupe). Don't worry about duplicates.
- For base64, do not include the `data:image/...;base64,` prefix — strip it first.
- Only standard image MIMEs are accepted. PDFs, ZIPs, etc. are rejected (415).
- Max 25 MiB per file.
```

---

## 6. Quick connectivity test

If MCP is acting up, test the HTTP API directly with the same token to isolate the layer:

```bash
ID=<your-client-id>
SEC=<your-client-secret>

# Empty list = creds OK, server OK
curl -s https://img.selfstudio.fun/api/list \
  -H "CF-Access-Client-Id: $ID" -H "CF-Access-Client-Secret: $SEC" | jq '.'

# 1x1 pixel upload smoke test
printf '\x89PNG\r\n\x1a\n' > /tmp/x.png  # not a real png, just to test rejection path
curl -X PUT https://img.selfstudio.fun/api/upload \
  -H "CF-Access-Client-Id: $ID" -H "CF-Access-Client-Secret: $SEC" \
  -H "content-type: image/png" --data-binary @/tmp/x.png
```

- `302 → cloudflareaccess.com/cdn-cgi/access/login` = token rejected by CF Access (revoked or wrong)
- `401/403` from worker = `verifyAccess` failed inside worker (rare)
- `200` / `201` = end-to-end fine

---

## 7. Operational notes (for the owner, not the agent)

- All `/api/*` and `/mcp` paths are protected by Cloudflare Access; service-token requests must match a `non_identity` policy on app `imgbed-mcp`. `POST /api/tokens` auto-creates that policy; `DELETE /api/tokens/:id` auto-removes it.
- R2 bucket: `imgbed` (account `e20ba8822b4b245e3185a32f1f748afa`, region `WNAM`).
- Worker source: `src/index.ts`. Redeploy: `npm run deploy`.
- Per-token audit / rotation: dashboard → Zero Trust → Access → Service Auth → Service Tokens (or `scripts/token-list.sh`).
