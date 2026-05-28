# cf-imgbed-mcp

A self-hosted image bed on **Cloudflare Workers + R2** with a built-in **Model Context Protocol (MCP) server** so AI agents can upload, list, fetch, and delete images directly.

Single Worker. ~500 LOC. Cloudflare Access for auth. Service-token issuance via CLI **and** API.

```
+----------------------------------------------------------+
|              Cloudflare Worker (Hono)                    |
|                                                          |
|   GET  /img/:key      (public, CDN immutable cache) --+  |
|                                                       |  |
|   GET  /api/list                                      |  |
|   PUT  /api/upload    multipart or raw image/*        |  |
|   GET  /api/info/:key                                 |  |
|   DEL  /api/:key                                      +--+--> R2 bucket
|                                                       |  |
|   GET  /api/tokens    list service tokens             |  |
|   POST /api/tokens    create + bind Access policy     |  |
|   POST /api/tokens/:id/rotate                         |  |
|   DEL  /api/tokens/:id  revoke + remove policy        |  |
|                                                       |  |
|   ALL  /mcp           MCP Streamable HTTP transport   |  |
|                                                       |  |
|   GET  /health                                        |  |
+----------------------------------------------------------+
        ^^^ all /api/* and /mcp gated by Cloudflare Access ^^^
```

---

## Features

- 🪣 **R2-backed**, no egress fees on Cloudflare
- 🔐 **Cloudflare Access** in front, OTP for owner + service tokens for agents/scripts
- 🤖 **First-class MCP**: `upload_image`, `list_images`, `get_image_info`, `delete_image` (Streamable HTTP)
- 🔁 **Content-addressed keys** — same bytes → same URL → free dedupe
- 🎛 **Token CRUD via CLI _and_ HTTP API** — auto-attaches/removes per-token Access policy
- 🛡 CORS allowlist, `Content-Length` precheck, MIME whitelist, 25 MiB limit
- 🚀 One-file Worker, push-to-deploy via GitHub Actions

---

## Quickstart (fork & deploy)

### 0. Prerequisites

- Cloudflare account with R2 enabled
- A domain on Cloudflare (you'll bind a subdomain to the Worker)
- Zero Trust (Access) enabled — free tier is enough
- Node ≥ 20, npm
- [`gh`](https://cli.github.com/) or git

### 1. Clone & install

```bash
git clone https://github.com/CodeEagle/cf-imgbed-mcp.git
cd cf-imgbed-mcp
npm install
cp wrangler.example.jsonc wrangler.jsonc
cp .env.example .env
cp .dev.vars.example .dev.vars
```

### 2. Create resources

**Cloudflare API token**

[dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) → **Create Token** → Custom → permissions:

| Resource | Permission |
|----------|-----------|
| Account / Workers Scripts | Edit |
| Account / Workers R2 Storage | Edit |
| Account / Account Settings | Read |
| Account / Access: Apps and Policies | Edit |
| Account / Access: Service Tokens | Edit |
| Account / Access: Organizations, Identity Providers, and Groups | Read |
| Account / Zero Trust | Read |
| Zone / DNS | Edit |
| Zone / Workers Routes | Edit |
| Zone / Zone | Read |

Save → `CLOUDFLARE_API_TOKEN`. Drop it in `.env`.

**R2 bucket**

```bash
npx wrangler r2 bucket create imgbed     # rename if you like
```

**Cloudflare Access self-hosted app**

Zero Trust dashboard → **Access** → **Applications** → **Add an application** → **Self-hosted**:

- **Destinations**:
  - `img.yourdomain.com/api` (type: public)
  - `img.yourdomain.com/mcp` (type: public)
- **Session duration**: 24h
- **Identity provider**: at least one (one-time-pin via email works without IdP setup)
- **`auto_redirect_to_identity`**: OFF (so service tokens bypass IdP redirect)
- Create a **policy** (decision **Allow**, include your email) for browser/OTP access
- Note the **Application Audience (AUD) tag** from the app's overview

### 3. Fill in `wrangler.jsonc`

Edit your local `wrangler.jsonc` (gitignored — your real values stay off GitHub):

```jsonc
"vars": {
  "PUBLIC_BASE_URL":    "https://img.yourdomain.com",
  "ACCESS_TEAM_DOMAIN": "https://YOUR-TEAM.cloudflareaccess.com",
  "ACCESS_AUD":         "<AUD from step 2>",
  "MAX_UPLOAD_BYTES":   "26214400",
  "CF_ACCOUNT_ID":      "<your account id>",
  "ACCESS_APP_ID":      "<Access app id from step 2>",
  "ALLOWED_ORIGINS":    "*"
},
"routes": [
  { "pattern": "img.yourdomain.com", "custom_domain": true }
]
```

`CF_API_TOKEN` is **not** a var — set it as a Worker secret so `/api/tokens` can call back into CF API:

```bash
echo "$CLOUDFLARE_API_TOKEN" | npx wrangler secret put CF_API_TOKEN
```

### 4. Deploy

```bash
npm run deploy
```

Wrangler binds the custom domain automatically (`custom_domain: true`).

### 5. First-time verify

Browser-open `https://img.yourdomain.com/api/list` → Access OTP login → JSON `{items:[],...}` = ✅.

Mint a service token for an agent:

```bash
scripts/token-create.sh agent-claude
# prints CF-Access-Client-Id + Secret (secret shown once)
```

Smoke-test it:

```bash
ID=...
SEC=...
curl -X PUT https://img.yourdomain.com/api/upload \
  -H "CF-Access-Client-Id: $ID" \
  -H "CF-Access-Client-Secret: $SEC" \
  -H "content-type: image/png" \
  --data-binary @photo.png
```

---

## HTTP API

All `/api/*` and `/mcp` paths require a valid Cloudflare Access credential — either an OTP-issued JWT (`cf-access-jwt-assertion` header) or a service token (`CF-Access-Client-Id` + `CF-Access-Client-Secret` headers).

| Method | Path | Body / Query | Purpose |
|-------|------|--------------|---------|
| GET   | `/health`                       | —                                 | liveness + version |
| GET   | `/img/:key`                     | —                                 | public image fetch (no auth) |
| PUT/POST | `/api/upload`                | multipart `file=` or raw `image/*` | upload |
| GET   | `/api/list`                     | `?prefix=&cursor=&limit=`         | list objects |
| GET   | `/api/info/:key`                | —                                 | head + metadata |
| DELETE| `/api/:key`                     | —                                 | delete object |
| GET   | `/api/tokens`                   | —                                 | list service tokens |
| POST  | `/api/tokens`                   | `{name, duration?}`               | create token + auto-bind Access policy |
| POST  | `/api/tokens/:id/rotate`        | —                                 | rotate secret |
| DELETE| `/api/tokens/:id`               | —                                 | revoke token + remove policy |
| ALL   | `/mcp`                          | MCP Streamable HTTP               | MCP server |

Key format: `YYYYMM/<sha256[:16]>.<ext>`. Re-upload of identical bytes is a free no-op.

## MCP

See [`MCP_USAGE.md`](MCP_USAGE.md) for the full tool reference + client config snippets you can paste into Claude Code, Codex, or any Streamable-HTTP MCP client.

## Service-token management

Two equivalent paths, both auto-manage the matching Access `non_identity` policy:

```bash
scripts/token-create.sh <name> [duration]     # forever | 8760h | 720h
scripts/token-list.sh
scripts/token-rotate.sh <token_id>
scripts/token-delete.sh <token_id>
```

```bash
curl -X POST https://img.yourdomain.com/api/tokens \
  -H "CF-Access-Client-Id: ..." -H "CF-Access-Client-Secret: ..." \
  -H "content-type: application/json" \
  -d '{"name":"agent-name","duration":"forever"}'
```

Each token is bound to an Access policy named `token-<id>`. `DELETE /api/tokens/:id` removes both atomically.

## GitHub Actions auto-deploy

`.github/workflows/deploy.yml` runs on push to `main`. Set these in **Settings → Secrets and variables → Actions**:

| Kind | Name | Example |
|------|------|---------|
| Secret | `CLOUDFLARE_API_TOKEN` | (your CF token from step 2) |
| Secret | `PUBLIC_BASE_URL` | `https://img.yourdomain.com` |
| Secret | `ACCESS_TEAM_DOMAIN` | `https://your-team.cloudflareaccess.com` |
| Secret | `ACCESS_AUD` | (AUD tag) |
| Secret | `CF_ACCOUNT_ID` | (account id) |
| Secret | `ACCESS_APP_ID` | (Access app id) |
| Secret | `CUSTOM_DOMAIN` | `img.yourdomain.com` |
| Variable | `R2_BUCKET` | `imgbed` (default) |
| Variable | `MAX_UPLOAD_BYTES` | `26214400` (default 25 MiB) |
| Variable | `ALLOWED_ORIGINS` | `*` (default) |

CI renders `wrangler.example.jsonc` → `wrangler.jsonc` with these values, then `wrangler deploy`.

## Customising

- **Storage**: bucket name in `r2_buckets[0].bucket_name`
- **Image limit**: `MAX_UPLOAD_BYTES`
- **Allowed MIMEs**: edit `ALLOWED_MIME` in `src/index.ts` (SVG removed if you don't want XSS surface)
- **CORS**: `ALLOWED_ORIGINS` var (comma-separated, `*` = open)
- **R2 public delivery**: bind a public R2.dev or custom domain directly to the bucket and point `PUBLIC_BASE_URL` there to skip Worker egress

## Local dev

```bash
npm run dev
```

`wrangler dev` will start a local server with `.dev.vars` injected. CF Access is **not** enforced locally — be aware.

## License

[MIT](LICENSE)
