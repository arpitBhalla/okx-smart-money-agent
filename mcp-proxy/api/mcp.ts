/**
 * Public MCP endpoint for OKX.AI's A2MCP service: a thin proxy in front of Datadash's MCP server.
 *
 * OKX's CLI calls a listed A2MCP endpoint directly and can't send our Datadash API key, and the key must never
 * appear in a listing. So this function adds the key on the server side, and in exchange keeps the public surface
 * small: read-only tools only (the cohort tools would create, change or reveal cohorts on our account), a request
 * size cap, and a per-caller rate limit.
 */

import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import {
  x402HTTPResourceServer,
  x402ResourceServer,
  type FacilitatorClient,
  type HTTPAdapter,
  type HTTPRequestContext,
  type HTTPResponseInstructions,
} from "@okxweb3/x402-core/server";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";

const UPSTREAM = process.env.DATADASH_MCP_URL || "https://api.datadash.xyz/mcp";
const ROUTE = "POST /api/mcp";

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

/**
 * The tools a caller pays for, one payment per call. The handshake, tools/list and get_schema stay free: an agent
 * has to be able to connect and learn the tables before it can decide to buy a query.
 */
export const PAID_TOOLS = new Set(["query_table", "query_lookup"]);

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

/** Whether a request carries a paid tool call. */
export function needsPayment(parsed: unknown): boolean {
  const messages = (Array.isArray(parsed) ? parsed : [parsed]) as JsonRpc[];
  return messages.some((m) => m?.method === "tools/call" && PAID_TOOLS.has(String(m.params?.name)));
}

/**
 * Whether an upstream answer failed, as a JSON-RPC error or an MCP tool error (`result.isError`). A failed query
 * is not settled, so the caller is never charged for it.
 */
export function hasRpcError(body: string, contentType: string): boolean {
  let failed = false;
  try {
    rewriteMessages(body, contentType, (message) => {
      const m = message as { error?: unknown; result?: { isError?: boolean } };
      if (m?.error || m?.result?.isError === true) failed = true;
      return message;
    });
  } catch {
    return true;
  }
  return failed;
}

/**
 * The x402 paywall over OKX's facilitator: a 402 challenge for an unpaid query, verification of a paid one, and
 * settlement on X Layer once the answer is good. Payment is waived for everything that isn't a paid tool call.
 */
export function createPaywall(
  facilitator: FacilitatorClient,
  opts: { payTo: string; price: string; network: string },
): x402HTTPResourceServer {
  const network = opts.network as `${string}:${string}`;
  const resource = new x402ResourceServer(facilitator);
  resource.register(network, new ExactEvmScheme());
  const paywall = new x402HTTPResourceServer(resource, {
    [ROUTE]: {
      accepts: [{ scheme: "exact", network, payTo: opts.payTo, price: opts.price }],
      description: "Datadash Polymarket smart-money data: one query_table or query_lookup call",
      mimeType: "application/json",
    },
  });
  paywall.onProtectedRequest(async (context) =>
    needsPayment(context.adapter.getBody?.()) ? undefined : { grantAccess: true },
  );
  return paywall;
}

/**
 * The live paywall, or null when payments aren't configured: then every tool is free, as before. Built once per
 * instance; a failed start (the facilitator unreachable) is retried on the next request.
 */
let paywall: Promise<x402HTTPResourceServer | null> | undefined;
function livePaywall(): Promise<x402HTTPResourceServer | null> {
  if (paywall) return paywall;
  const { OKX_API_KEY, OKX_SECRET_KEY, OKX_PASSPHRASE, PAY_TO_ADDRESS } = process.env;
  if (!OKX_API_KEY || !OKX_SECRET_KEY || !OKX_PASSPHRASE || !PAY_TO_ADDRESS) {
    console.log("payments off: set OKX_API_KEY, OKX_SECRET_KEY, OKX_PASSPHRASE and PAY_TO_ADDRESS to charge per query");
    return (paywall = Promise.resolve(null));
  }
  const server = createPaywall(
    new OKXFacilitatorClient({ apiKey: OKX_API_KEY, secretKey: OKX_SECRET_KEY, passphrase: OKX_PASSPHRASE, syncSettle: true }),
    { payTo: PAY_TO_ADDRESS, price: process.env.X402_PRICE || "$0.01", network: process.env.X402_NETWORK || "eip155:196" },
  );
  paywall = server.initialize().then(
    () => server,
    (error: Error) => {
      paywall = undefined;
      throw error;
    },
  );
  return paywall;
}

export function adapterFor(request: Request, body: unknown): HTTPAdapter {
  const url = new URL(request.url);
  return {
    getHeader: (name) => request.headers.get(name) ?? undefined,
    getMethod: () => request.method,
    getPath: () => url.pathname,
    getUrl: () => request.url,
    getAcceptHeader: () => request.headers.get("accept") ?? "",
    getUserAgent: () => request.headers.get("user-agent") ?? "",
    getBody: () => body,
  };
}

const fromInstructions = ({ status, headers, body }: HTTPResponseInstructions) =>
  new Response(body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers,
  });

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

  // A paid query must carry a valid payment before it reaches Datadash.
  let gate: x402HTTPResourceServer | null = null;
  let context: HTTPRequestContext | undefined;
  let verified: Awaited<ReturnType<x402HTTPResourceServer["processHTTPRequest"]>> | undefined;
  if (needsPayment(parsed)) {
    try {
      gate = await livePaywall();
    } catch (error) {
      console.error(`payments unavailable: ${(error as Error).message}`);
      return json(503, rpcError(messages[0]?.id, -32603, "payments are temporarily unavailable; try again shortly"));
    }
    if (gate) {
      context = { adapter: adapterFor(request, parsed), path: new URL(request.url).pathname, method: "POST" };
      verified = await gate.processHTTPRequest(context);
      if (verified.type === "payment-error") return fromInstructions(verified.response);
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

  // A paid query settles only after Datadash answered it well; a failed one is returned without charging.
  if (gate && context && verified?.type === "payment-verified") {
    const body = await upstream.text();
    if (!upstream.ok || hasRpcError(body, headers["content-type"] ?? "")) {
      console.log(`not settled: upstream ${upstream.status} or tool error for ${caller}`);
      return new Response(body, { status: upstream.status, headers });
    }
    const settled = await gate.processSettlement(
      verified.paymentPayload,
      verified.paymentRequirements,
      verified.declaredExtensions,
      { request: context, responseBody: Buffer.from(body) },
    );
    if (!settled.success) {
      console.error(`settlement failed for ${caller}: ${settled.errorReason}`);
      return fromInstructions(settled.response);
    }
    console.log(`settled ${settled.transaction ?? ""} for ${caller}`);
    return new Response(body, { status: upstream.status, headers: { ...headers, ...settled.headers } });
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
