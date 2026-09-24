import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanDescription, cleanSchema, filterToolList, rateLimited, rejectMessage, rewriteMessages } from "../mcp-proxy/api/mcp.ts";

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
