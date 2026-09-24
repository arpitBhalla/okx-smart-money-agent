/**
 * Public MCP endpoint for OKX.AI's A2MCP service: a thin proxy in front of Datadash's MCP server.
 *
 * OKX's CLI calls a listed A2MCP endpoint directly and can't send our Datadash API key, and the key must never
 * appear in a listing. So this function adds the key on the server side, and in exchange keeps the public surface
 * small: read-only tools only (the cohort tools would create, change or reveal cohorts on our account), a request
 * size cap, and a per-caller rate limit.
 */

const UPSTREAM = process.env.DATADASH_MCP_URL || "https://api.datadash.xyz/mcp";

/** The read-only tools. Everything cohort-related stays private to our key's account. */
export const ALLOWED_TOOLS = new Set(["get_schema", "query_table", "query_lookup"]);

const ALLOWED_METHODS = new Set([
  "initialize",
  "ping",
  "tools/list",
  "tools/call",
  "resources/list",
  "resources/read",
  "resources/templates/list",
]);

const MAX_BODY_BYTES = 64 * 1024;
const RATE_LIMIT = { requests: 60, windowMs: 60_000 };

type JsonRpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: { name?: string } };

const rpcError = (id: JsonRpc["id"], code: number, message: string) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message },
});

/**
 * Why a JSON-RPC message may not go upstream, as a JSON-RPC error, or null when it may. Notifications
 * (`notifications/*`, no id) pass: they carry no data and clients send them as part of the MCP handshake.
 */
export function rejectMessage(message: JsonRpc): ReturnType<typeof rpcError> | null {
  const method = message?.method;
  if (typeof method !== "string") return rpcError(message?.id, -32600, "invalid request");
  if (method.startsWith("notifications/")) return null;
  if (!ALLOWED_METHODS.has(method)) return rpcError(message.id, -32601, `method not available here: ${method}`);
  if (method === "tools/call" && !ALLOWED_TOOLS.has(String(message.params?.name)))
    return rpcError(message.id, -32602, `tool not available here: ${message.params?.name}; use get_schema, query_table or query_lookup`);
  return null;
}

/** Drops the tools this endpoint doesn't serve from a `tools/list` result, so callers never see them. */
export function filterToolList(payload: unknown): unknown {
  const tools = (payload as { result?: { tools?: { name: string }[] } })?.result?.tools;
  if (!Array.isArray(tools)) return payload;
  const result = (payload as { result: object }).result;
  return { ...(payload as object), result: { ...result, tools: tools.filter((tool) => ALLOWED_TOOLS.has(tool.name)) } };
}

/**
 * Whether text names how Datadash stores the data rather than what it means: a snake_case column
 * (`total_bought_usd`), a `database.table` name (`polymarket.open_markets`) or a SQL function (`coalesce(`).
 */
const STORAGE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b|\b[a-z_]{2,}\.[a-z_]{2,}\b|\b(?:coalesce|nullif|ifnull|greatest|least)\s*\(/i;

/** MCP tool names are snake_case too, but they are the public interface, not storage. */
const TOOL_NAMES = /\b(?:get_schema|query_table|query_lookup|(?:create|update|delete|get|list)_(?:static_)?cohorts?(?:_wallets)?)\b/g;

/**
 * Removes storage expressions from a field or table description: every parenthetical that contains one, innermost
 * first so a nested `(coalesce(a, b) in db.table)` goes whole. Parentheticals meant for the reader, like
 * `(>1 = bigger than usual)`, stay.
 */
export function cleanDescription(text: string): string {
  let out = text;
  for (let pass = 0; pass < 5; pass++) {
    const next = out.replace(/\s*\(([^()]*)\)/g, (whole, inner: string) =>
      STORAGE.test(inner.replace(TOOL_NAMES, "")) ? "" : whole,
    );
    if (next === out) break;
    out = next;
  }
  return out.replace(/\s+([.,;:])/g, "$1").replace(/\s{2,}/g, " ").trim();
}

/**
 * Cleans every `description` in a schema answer. The schema arrives as JSON text inside the MCP result
 * (`content[].text`, or `contents[].text` for the resource), so text that parses as JSON is cleaned inside.
 */
export function cleanSchema(value: unknown, key = ""): unknown {
  if (typeof value === "string") {
    if (key === "description") return cleanDescription(value);
    if (key === "text" && value.trimStart().startsWith("{")) {
      try {
        return JSON.stringify(cleanSchema(JSON.parse(value)));
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => cleanSchema(item, key));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cleanSchema(v, k)]));
  return value;
}

/** Applies `edit` to each JSON message in a response body, whether plain JSON or a server-sent event stream. */
export function rewriteMessages(body: string, contentType: string, edit: (message: unknown) => unknown): string {
  if (!contentType.includes("text/event-stream")) return JSON.stringify(edit(JSON.parse(body)));
  return body
    .split("\n")
    .map((line) => {
      if (!line.startsWith("data:")) return line;
      try {
        return `data: ${JSON.stringify(edit(JSON.parse(line.slice(5))))}`;
      } catch {
        return line;
      }
    })
    .join("\n");
}

/**
 * Best-effort per-caller limit, per function instance. Fluid Compute shares an instance between concurrent
 * requests, so this catches bursts; a Vercel Firewall rate-limit rule is the global backstop.
 */
const hits = new Map<string, number[]>();
export function rateLimited(caller: string, now = Date.now()): boolean {
  const recent = (hits.get(caller) ?? []).filter((at) => now - at < RATE_LIMIT.windowMs);
  recent.push(now);
  hits.set(caller, recent);
  if (hits.size > 10_000) hits.clear();
  return recent.length > RATE_LIMIT.requests;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export async function POST(request: Request): Promise<Response> {
  const apiKey = process.env.DATADASH_API_KEY;
  if (!apiKey) return json(500, rpcError(null, -32603, "proxy is not configured"));

  const caller = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (rateLimited(caller))
    return json(429, rpcError(null, -32000, "too many requests; try again in a minute"), { "retry-after": "60" });

  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return json(413, rpcError(null, -32600, "request too large"));

  let parsed: JsonRpc | JsonRpc[];
  try {
    parsed = JSON.parse(raw);
  } catch {
    return json(400, rpcError(null, -32700, "parse error: the body must be a JSON-RPC message"));
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  for (const message of messages) {
    const rejected = rejectMessage(message);
    if (rejected) {
      console.log(`rejected ${message?.method ?? "?"} ${message?.params?.name ?? ""} from ${caller}`);
      return json(200, rejected);
    }
  }

  const forward: Record<string, string> = {
    "content-type": "application/json",
    accept: request.headers.get("accept") || "application/json, text/event-stream",
    "X-Api-Key": apiKey,
  };
  for (const name of ["mcp-session-id", "mcp-protocol-version", "last-event-id"]) {
    const value = request.headers.get(name);
    if (value) forward[name] = value;
  }

  let upstream: Response;
  try {
    upstream = await fetch(UPSTREAM, {
      method: "POST",
      headers: forward,
      body: raw,
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    console.error(`upstream unreachable: ${(error as Error).message}`);
    return json(502, rpcError(messages[0]?.id, -32603, "Datadash is unreachable; try again shortly"));
  }
  if (!upstream.ok) console.error(`upstream answered ${upstream.status} to ${messages.map((m) => m.method).join(",")}`);
  const headers: Record<string, string> = {};
  for (const name of ["content-type", "mcp-session-id", "cache-control"]) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }

  // Answers that describe the data get edited: tools/list loses the private tools, and the schema (as a tool
  // result or as a resource) loses its storage expressions. Everything else streams straight through.
  const describes = (message: JsonRpc) =>
    message.method === "tools/list" ||
    message.method === "resources/read" ||
    (message.method === "tools/call" && message.params?.name === "get_schema");
  if (messages.some(describes) && upstream.ok) {
    const body = await upstream.text();
    const edit = (message: unknown) => cleanSchema(filterToolList(message));
    return new Response(rewriteMessages(body, headers["content-type"] ?? "", edit), {
      status: upstream.status,
      headers,
    });
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

/** No server-initiated stream and no session teardown: MCP clients fall back to plain POSTs. */
export function GET(): Response {
  return json(405, rpcError(null, -32000, "use POST"), { allow: "POST" });
}

export function DELETE(): Response {
  return json(405, rpcError(null, -32000, "use POST"), { allow: "POST" });
}
