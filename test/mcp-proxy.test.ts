import assert from "node:assert/strict";
import { test } from "node:test";
import {
  adapterFor,
  cleanDescription,
  cleanSchema,
  createPaywall,
  filterToolList,
  hasRpcError,
  needsPayment,
  rateLimited,
  rejectMessage,
  rewriteMessages,
} from "../mcp-proxy/api/mcp.ts";

test("only read-only tools and the MCP handshake get through", () => {
  assert.equal(rejectMessage({ method: "initialize", id: 1 }), null);
  assert.equal(rejectMessage({ method: "notifications/initialized" }), null);
  assert.equal(rejectMessage({ method: "tools/list", id: 2 }), null);
  assert.equal(rejectMessage({ method: "tools/call", id: 3, params: { name: "query_table" } }), null);
  assert.equal(rejectMessage({ method: "tools/call", id: 4, params: { name: "delete_cohort" } })?.error.code, -32602);
  assert.equal(rejectMessage({ method: "tools/call", id: 5, params: { name: "list_cohorts" } })?.error.code, -32602);
  assert.equal(rejectMessage({ method: "sampling/createMessage", id: 6 })?.error.code, -32601);
  assert.equal(rejectMessage({ id: 7 } as never)?.error.code, -32600);
});

test("tools/list hides every tool this endpoint doesn't serve, in JSON and in SSE answers", () => {
  const answer = {
    jsonrpc: "2.0",
    id: 2,
    result: { tools: [{ name: "get_schema" }, { name: "create_cohort" }, { name: "query_table" }, { name: "query_lookup" }] },
  };
  const names = (body: string) => (JSON.parse(body) as typeof answer).result.tools.map((t) => t.name);
  assert.deepEqual(names(rewriteMessages(JSON.stringify(answer), "application/json", filterToolList)), [
    "get_schema",
    "query_table",
    "query_lookup",
  ]);
  const sse = `event: message\ndata: ${JSON.stringify(answer)}\n\n`;
  const rewritten = rewriteMessages(sse, "text/event-stream", filterToolList);
  assert.match(rewritten, /^event: message\ndata: /);
  assert.deepEqual(names(rewritten.split("\n")[1].slice(6)), ["get_schema", "query_table", "query_lookup"]);
});

test("a caller over 60 requests a minute is limited; the window slides", () => {
  const t0 = 1_000_000;
  for (let i = 0; i < 60; i++) assert.equal(rateLimited("1.2.3.4", t0 + i), false);
  assert.equal(rateLimited("1.2.3.4", t0 + 100), true);
  assert.equal(rateLimited("5.6.7.8", t0 + 100), false, "per caller");
  assert.equal(rateLimited("1.2.3.4", t0 + 61_000), false, "a minute later");
});

test("schema descriptions lose storage expressions but keep notes meant for the reader", () => {
  const cases: [string, string][] = [
    ["Average entry price of the shares still held (p_in)", "Average entry price of the shares still held"],
    ["Signed price move since entry (p_now - p_in)", "Signed price move since entry"],
    ["The market's on-book liquidity (polymarket.open_markets.liquidity)", "The market's on-book liquidity"],
    [
      "Whole days until the end date, falling back to the event's (coalesce(end_date, event_end_date) in polymarket.open_markets), null if neither is set",
      "Whole days until the end date, falling back to the event's, null if neither is set",
    ],
    ["This bet vs the wallet's usual size (>1 = bigger than usual)", "This bet vs the wallet's usual size (>1 = bigger than usual)"],
    ["Days from now to market end (<0 = overdue)", "Days from now to market end (<0 = overdue)"],
  ];
  for (const [input, expected] of cases) assert.equal(cleanDescription(input), expected);
});

test("the schema is cleaned inside the JSON text of a tool result, and nothing else changes", () => {
  const schema = { tables: [{ id: "signalScore", description: "Scores", fields: [{ id: "pNow", title: "p_now", description: "Live price (p_now)" }] }] };
  const message = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(schema) }] } };
  const cleaned = cleanSchema(message) as typeof message;
  const inner = JSON.parse(cleaned.result.content[0].text) as typeof schema;
  assert.equal(inner.tables[0].fields[0].description, "Live price");
  assert.equal(inner.tables[0].fields[0].title, "p_now", "only descriptions are edited");
  assert.equal(inner.tables[0].fields[0].id, "pNow");
});

test("tool names are not mistaken for storage", () => {
  assert.equal(cleanDescription("Run a query (call get_schema first)."), "Run a query (call get_schema first).");
  assert.equal(cleanDescription("Price (p_now), see get_schema"), "Price, see get_schema");
});

test("only query calls are paid; the handshake, the tool list and get_schema stay free", () => {
  assert.equal(needsPayment({ method: "tools/call", params: { name: "query_table" } }), true);
  assert.equal(needsPayment({ method: "tools/call", params: { name: "query_lookup" } }), true);
  assert.equal(needsPayment({ method: "tools/call", params: { name: "get_schema" } }), false);
  assert.equal(needsPayment({ method: "tools/list" }), false);
  assert.equal(needsPayment([{ method: "initialize" }, { method: "tools/call", params: { name: "query_table" } }]), true);
});

test("a failed query is recognised, so it is never settled", () => {
  const ok = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } });
  assert.equal(hasRpcError(ok, "application/json"), false);
  assert.equal(hasRpcError(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -1 } }), "application/json"), true);
  assert.equal(hasRpcError(`event: message\ndata: ${JSON.stringify({ id: 1, result: { isError: true } })}\n\n`, "text/event-stream"), true);
  assert.equal(hasRpcError("not json", "application/json"), true);
});

test("an unpaid query gets an x402 challenge for X Layer; free calls pass without one", async () => {
  const facilitator = {
    verify: async () => ({ isValid: false }),
    settle: async () => ({ success: false }),
    getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:196" }], extensions: [], signers: {} }),
  };
  const payTo = "0x00fdd6dd4d5ea43c2560dc46b295f0e0fac7292c";
  const paywall = createPaywall(facilitator as never, { payTo, price: "$0.01", network: "eip155:196" });
  await paywall.initialize();
  const request = (body: object) =>
    new Request("https://okx.datadash.vercel.app/api/mcp", { method: "POST", headers: { accept: "application/json, text/event-stream" }, body: JSON.stringify(body) });
  const context = (body: object) => ({ adapter: adapterFor(request(body), body), path: "/api/mcp", method: "POST" });

  const query = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "query_table", arguments: {} } };
  const unpaid = await paywall.processHTTPRequest(context(query));
  assert.equal(unpaid.type, "payment-error");
  if (unpaid.type !== "payment-error") return;
  assert.equal(unpaid.response.status, 402);
  const challenge = unpaid.response.headers["PAYMENT-REQUIRED"] ?? unpaid.response.headers["payment-required"];
  assert.ok(challenge, "the 402 carries a PAYMENT-REQUIRED header");
  const decoded = JSON.parse(Buffer.from(challenge, "base64").toString("utf8"));
  const offer = decoded.accepts[0];
  assert.equal(offer.network, "eip155:196");
  assert.equal(offer.payTo.toLowerCase(), payTo);
  assert.ok(Number(offer.amount ?? offer.maxAmountRequired) > 0);

  const schema = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_schema", arguments: {} } };
  assert.equal((await paywall.processHTTPRequest(context(schema))).type, "no-payment-required");
});
