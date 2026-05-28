import { Hono } from "hono";
import { cors } from "hono/cors";
import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jwtVerify, createRemoteJWKSet, type JWTPayload } from "jose";

type Env = {
  BUCKET: R2Bucket;
  PUBLIC_BASE_URL: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  MAX_UPLOAD_BYTES: string;
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;
  ACCESS_APP_ID?: string;
  ALLOWED_ORIGINS?: string;
};

const VERSION = "0.1.0";

async function cfApi(
  env: Env,
  method: string,
  path: string,
  body?: unknown
): Promise<any> {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) {
    throw new HttpError(
      503,
      "token management disabled: CF_API_TOKEN / CF_ACCOUNT_ID not configured"
    );
  }
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const json = (await res.json()) as any;
  if (!json.success) {
    throw new HttpError(res.status || 500, JSON.stringify(json.errors ?? json));
  }
  return json.result;
}

const ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/svg+xml",
  "image/bmp",
  "image/x-icon"
]);

const EXT_FROM_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/x-icon": "ico"
};

// ---------- Helpers ----------

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

function keyFor(hash: string, mime: string): string {
  const ext = EXT_FROM_MIME[mime] ?? "bin";
  const yyyymm = new Date().toISOString().slice(0, 7).replace("-", "");
  return `${yyyymm}/${hash.slice(0, 16)}.${ext}`;
}

function publicUrlFor(env: Env, key: string): string {
  return `${env.PUBLIC_BASE_URL.replace(/\/+$/, "")}/img/${key}`;
}

type StoredImageInfo = {
  key: string;
  url: string;
  size: number;
  contentType: string;
  etag: string;
  uploaded: string;
};

async function storeBytes(
  env: Env,
  bytes: ArrayBuffer,
  mime: string
): Promise<StoredImageInfo> {
  if (!ALLOWED_MIME.has(mime)) {
    throw new HttpError(415, `unsupported content-type: ${mime}`);
  }
  const max = Number(env.MAX_UPLOAD_BYTES || "26214400");
  if (bytes.byteLength > max) {
    throw new HttpError(413, `file too large (${bytes.byteLength} > ${max})`);
  }
  const hash = await sha256Hex(bytes);
  const key = keyFor(hash, mime);
  const existing = await env.BUCKET.head(key);
  const obj =
    existing ??
    (await env.BUCKET.put(key, bytes, {
      httpMetadata: { contentType: mime },
      customMetadata: { sha256: hash }
    }));
  return {
    key,
    url: publicUrlFor(env, key),
    size: obj.size,
    contentType: obj.httpMetadata?.contentType ?? mime,
    etag: obj.etag,
    uploaded: obj.uploaded.toISOString()
  };
}

async function fetchRemote(url: string): Promise<{ bytes: ArrayBuffer; mime: string }> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new HttpError(400, `fetch failed: ${res.status}`);
  const mime = (res.headers.get("content-type") ?? "").split(";")[0].trim();
  const bytes = await res.arrayBuffer();
  return { bytes, mime };
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// ---------- CF Access JWT middleware ----------

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

async function verifyAccess(req: Request, env: Env): Promise<JWTPayload> {
  const token =
    req.headers.get("cf-access-jwt-assertion") ??
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    "";
  if (!token) throw new HttpError(401, "missing cf-access-jwt-assertion");
  if (!env.ACCESS_AUD || env.ACCESS_AUD.startsWith("REPLACE")) {
    throw new HttpError(500, "ACCESS_AUD not configured");
  }
  jwks ??= createRemoteJWKSet(
    new URL(`${env.ACCESS_TEAM_DOMAIN.replace(/\/+$/, "")}/cdn-cgi/access/certs`)
  );
  const { payload } = await jwtVerify(token, jwks, {
    issuer: env.ACCESS_TEAM_DOMAIN.replace(/\/+$/, ""),
    audience: env.ACCESS_AUD
  });
  return payload;
}

// ---------- MCP server factory ----------

function buildMcpServer(env: Env): McpServer {
  const server = new McpServer({
    name: "cf-imgbed-mcp",
    version: "0.1.0"
  });

  server.registerTool(
    "upload_image",
    {
      description:
        "Upload an image to the image bed. Provide EITHER base64 data + content_type OR a remote url. Returns the public URL.",
      inputSchema: {
        base64: z.string().optional().describe("base64-encoded image bytes (no data: prefix)"),
        content_type: z.string().optional().describe("MIME type, required when base64 is used"),
        url: z.string().url().optional().describe("fetch image from this URL and upload")
      }
    },
    async ({ base64, content_type, url }) => {
      let bytes: ArrayBuffer;
      let mime: string;
      if (url) {
        const r = await fetchRemote(url);
        bytes = r.bytes;
        mime = r.mime;
      } else if (base64 && content_type) {
        const bin = atob(base64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        bytes = arr.buffer;
        mime = content_type;
      } else {
        throw new Error("provide either { base64, content_type } or { url }");
      }
      const info = await storeBytes(env, bytes, mime);
      return {
        content: [{ type: "text", text: JSON.stringify(info, null, 2) }]
      };
    }
  );

  server.registerTool(
    "list_images",
    {
      description: "List images in the bucket, paginated.",
      inputSchema: {
        prefix: z.string().optional(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(1000).optional()
      }
    },
    async ({ prefix, cursor, limit }) => {
      const res = await env.BUCKET.list({
        prefix,
        cursor,
        limit: limit ?? 100
      });
      const items = res.objects.map(o => ({
        key: o.key,
        url: publicUrlFor(env, o.key),
        size: o.size,
        contentType: o.httpMetadata?.contentType,
        uploaded: o.uploaded.toISOString(),
        etag: o.etag
      }));
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { items, truncated: res.truncated, cursor: res.truncated ? res.cursor : null },
              null,
              2
            )
          }
        ]
      };
    }
  );

  server.registerTool(
    "delete_image",
    {
      description: "Delete an image by key.",
      inputSchema: { key: z.string() }
    },
    async ({ key }) => {
      await env.BUCKET.delete(key);
      return { content: [{ type: "text", text: `deleted ${key}` }] };
    }
  );

  server.registerTool(
    "get_image_info",
    {
      description: "Get metadata (size, type, uploaded_at, url) for a single key.",
      inputSchema: { key: z.string() }
    },
    async ({ key }) => {
      const head = await env.BUCKET.head(key);
      if (!head) {
        return { content: [{ type: "text", text: `not found: ${key}` }], isError: true };
      }
      const info = {
        key,
        url: publicUrlFor(env, key),
        size: head.size,
        contentType: head.httpMetadata?.contentType,
        uploaded: head.uploaded.toISOString(),
        etag: head.etag,
        customMetadata: head.customMetadata ?? {}
      };
      return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
    }
  );

  return server;
}

// ---------- Hono app ----------

const app = new Hono<{ Bindings: Env }>();

app.use("*", (c, next) =>
  cors({
    origin: origin => {
      const allow = (c.env.ALLOWED_ORIGINS ?? "*").split(",").map(s => s.trim()).filter(Boolean);
      if (allow.includes("*")) return origin ?? "*";
      if (origin && allow.includes(origin)) return origin;
      return null;
    },
    allowMethods: ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["content-type", "cf-access-jwt-assertion", "cf-access-client-id", "cf-access-client-secret", "authorization"]
  })(c, next)
);

app.get("/health", c =>
  c.json({
    ok: true,
    version: VERSION,
    service: "cf-imgbed-mcp"
  })
);

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
  console.error(err);
  return c.json({ error: "internal error" }, 500);
});

// Public image read — NO auth, served with strong cache headers.
app.get("/img/:key{.+}", async c => {
  const key = c.req.param("key");
  const obj = await c.env.BUCKET.get(key);
  if (!obj) return c.notFound();
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  return new Response(obj.body, { headers });
});

// Auth gate for /api/* and /mcp
const authGate = async (
  c: { req: { raw: Request }; env: Env },
  next: () => Promise<void>
) => {
  await verifyAccess(c.req.raw, c.env);
  await next();
};

app.use("/api/*", authGate);
app.use("/mcp", authGate);
app.use("/mcp/*", authGate);

// HTTP upload — accepts multipart (field "file") OR raw body with image content-type.
const uploadHandler = async (c: { req: any; env: Env; json: any }) => {
  const ct = c.req.header("content-type") ?? "";
  const max = Number(c.env.MAX_UPLOAD_BYTES || "26214400");
  const clHeader = c.req.header("content-length");
  if (clHeader && Number(clHeader) > max) {
    throw new HttpError(413, `payload too large per Content-Length (${clHeader} > ${max})`);
  }

  let bytes: ArrayBuffer;
  let mime: string;
  if (ct.startsWith("multipart/form-data")) {
    const form = await c.req.raw.formData();
    const f = form.get("file");
    if (!(f instanceof File)) throw new HttpError(400, "missing field 'file'");
    if (f.size > max) throw new HttpError(413, `file too large (${f.size} > ${max})`);
    bytes = await f.arrayBuffer();
    mime = f.type;
  } else if (ct.startsWith("image/")) {
    bytes = await c.req.raw.arrayBuffer();
    mime = ct.split(";")[0].trim();
  } else {
    throw new HttpError(415, "use multipart/form-data or raw body with image/* content-type");
  }
  const info = await storeBytes(c.env, bytes, mime);
  return c.json(info, 201);
};

app.put("/api/upload", uploadHandler);
app.post("/api/upload", uploadHandler);

app.get("/api/list", async c => {
  const prefix = c.req.query("prefix");
  const cursor = c.req.query("cursor");
  const limit = c.req.query("limit") ? Number(c.req.query("limit")) : 100;
  const res = await c.env.BUCKET.list({
    prefix,
    cursor,
    limit
  });
  return c.json({
    items: res.objects.map(o => ({
      key: o.key,
      url: publicUrlFor(c.env, o.key),
      size: o.size,
      contentType: o.httpMetadata?.contentType,
      uploaded: o.uploaded.toISOString(),
      etag: o.etag
    })),
    truncated: res.truncated,
    cursor: res.truncated ? res.cursor : null
  });
});

app.get("/api/info/:key{.+}", async c => {
  const key = c.req.param("key");
  const head = await c.env.BUCKET.head(key);
  if (!head) return c.json({ error: "not found" }, 404);
  return c.json({
    key,
    url: publicUrlFor(c.env, key),
    size: head.size,
    contentType: head.httpMetadata?.contentType,
    uploaded: head.uploaded.toISOString(),
    etag: head.etag,
    customMetadata: head.customMetadata ?? {}
  });
});

// --- Service token management ---

function requireAppId(env: Env): string {
  if (!env.ACCESS_APP_ID) {
    throw new HttpError(503, "token management disabled: ACCESS_APP_ID not configured");
  }
  return env.ACCESS_APP_ID;
}

const policyName = (tokenId: string) => `token-${tokenId}`;

async function findPolicyByName(env: Env, appId: string, name: string): Promise<string | null> {
  const pols = (await cfApi(env, "GET", `/accounts/${env.CF_ACCOUNT_ID}/access/apps/${appId}/policies`)) as any[];
  return pols.find(p => p.name === name)?.id ?? null;
}

app.get("/api/tokens", async c => {
  const list = await cfApi(c.env, "GET", `/accounts/${c.env.CF_ACCOUNT_ID}/access/service_tokens`);
  return c.json(
    (list as any[]).map(t => ({
      id: t.id,
      name: t.name,
      client_id: t.client_id,
      created_at: t.created_at,
      expires_at: t.expires_at ?? null,
      duration: t.duration
    }))
  );
});

app.post("/api/tokens", async c => {
  const appId = requireAppId(c.env);
  const body = await c.req.json().catch(() => ({} as any));
  const name = String(body.name ?? "").trim();
  if (!name) throw new HttpError(400, "missing 'name'");
  const duration = body.duration ? String(body.duration) : "forever";

  const created = await cfApi(
    c.env,
    "POST",
    `/accounts/${c.env.CF_ACCOUNT_ID}/access/service_tokens`,
    { name, duration }
  );

  // Attach non-identity policy so this token can pass Access on the app.
  await cfApi(c.env, "POST", `/accounts/${c.env.CF_ACCOUNT_ID}/access/apps/${appId}/policies`, {
    name: policyName(created.id),
    decision: "non_identity",
    include: [{ service_token: { token_id: created.id } }]
  });

  return c.json(
    {
      id: created.id,
      name: created.name,
      client_id: created.client_id,
      client_secret: created.client_secret,
      created_at: created.created_at,
      expires_at: created.expires_at ?? null,
      duration: created.duration,
      usage: {
        header_id: "CF-Access-Client-Id",
        header_secret: "CF-Access-Client-Secret"
      }
    },
    201
  );
});

app.post("/api/tokens/:id/rotate", async c => {
  const id = c.req.param("id");
  const rotated = await cfApi(
    c.env,
    "POST",
    `/accounts/${c.env.CF_ACCOUNT_ID}/access/service_tokens/${id}/rotate`
  );
  return c.json({
    id: rotated.id,
    name: rotated.name,
    client_id: rotated.client_id,
    client_secret: rotated.client_secret
  });
});

app.delete("/api/tokens/:id", async c => {
  const id = c.req.param("id");
  const appId = requireAppId(c.env);
  const polId = await findPolicyByName(c.env, appId, policyName(id));
  if (polId) {
    await cfApi(
      c.env,
      "DELETE",
      `/accounts/${c.env.CF_ACCOUNT_ID}/access/apps/${appId}/policies/${polId}`
    );
  }
  await cfApi(
    c.env,
    "DELETE",
    `/accounts/${c.env.CF_ACCOUNT_ID}/access/service_tokens/${id}`
  );
  return c.json({ deleted: id, policy_removed: polId ?? null });
});

// --- Image delete (must come AFTER /api/tokens routes to avoid catch-all stealing) ---

app.delete("/api/:key{.+}", async c => {
  const key = c.req.param("key");
  if (key.startsWith("tokens/") || key === "tokens") {
    throw new HttpError(404, "not found");
  }
  await c.env.BUCKET.delete(key);
  return c.json({ deleted: key });
});

// /mcp — Streamable HTTP MCP endpoint
app.all("/mcp", async c => {
  const handler = createMcpHandler(buildMcpServer(c.env));
  return handler(c.req.raw, c.env, c.executionCtx);
});

app.get("/", c =>
  c.text(
    `cf-imgbed-mcp\n\nendpoints:\n  GET    /img/:key         (public)\n  PUT    /api/upload      (multipart 'file' or raw image/* body)\n  GET    /api/list        (?prefix=&cursor=&limit=)\n  GET    /api/info/:key\n  DELETE /api/:key\n  ALL    /mcp             (MCP Streamable HTTP)\n\nAuth: Cloudflare Access JWT (header cf-access-jwt-assertion) on /api/* and /mcp.\n`
  )
);

export default app;
