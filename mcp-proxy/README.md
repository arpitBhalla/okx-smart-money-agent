# Datadash MCP proxy for OKX.AI (A2MCP)

The free A2MCP service on OKX.AI points here. OKX's CLI calls a listed A2MCP endpoint directly, so it can't send our
Datadash API key; this Vercel function adds the key on the server side and forwards to `api.datadash.xyz/mcp`.

In exchange it keeps the public surface small:

- Read-only tools only: `get_schema`, `query_table`, `query_lookup`. The cohort tools (create, update, delete, list)
  would act on our Datadash account, so they are hidden from `tools/list` and refused on `tools/call`.
- No storage details: Datadash's schema describes some fields with their internal columns, formulas or database
  tables (`(p_now - p_in)`, `(polymarket.open_markets.liquidity)`). The proxy strips those parentheticals from every
  description in `get_schema` and in the `datadashxyz://schema` resource, and keeps notes meant for the reader, such
  as `(>1 = bigger than usual)`.
- Requests up to 64 KB, POST only.
- 60 requests a minute per caller, per function instance. Add a Vercel Firewall rate-limit rule on `/api/mcp` for a
  global limit, since every call counts against our key.

## Paid queries (x402 on X Layer)

Each `query_table` or `query_lookup` call can cost a small fee, paid through OKX's x402 payment SDK
(`@okxweb3/x402-core`, `@okxweb3/x402-evm`). Connecting, `tools/list` and `get_schema` stay free, so an agent can
discover the data before paying.

- An unpaid query gets HTTP 402 with a `PAYMENT-REQUIRED` challenge: USD₮0 on X Layer, to `PAY_TO_ADDRESS`.
- The buyer's OKX agent pays from its Agentic Wallet and repeats the call with the signed payment.
- The proxy verifies the payment with OKX's facilitator, forwards the query, and settles on X Layer only if
  Datadash answered it without an error. A failed query is never charged.

Payments switch on when all four of these are set in Vercel; without them every tool is free, as before:

| Variable | Value |
| --- | --- |
| `OKX_API_KEY`, `OKX_SECRET_KEY`, `OKX_PASSPHRASE` | OKX Developer Portal API credentials |
| `PAY_TO_ADDRESS` | Wallet that receives payments, e.g. the agent's wallet |
| `X402_PRICE` (optional) | Price per query, default `$0.01` |
| `X402_NETWORK` (optional) | `eip155:196` X Layer mainnet (default), `eip155:1952` testnet |

Test on the testnet first. When paid mode is live, update the A2MCP listing's `fee` to match the price.

## Deploy

```bash
npm i -g vercel
cd mcp-proxy
vercel link                                   # create or pick the project
vercel env add DATADASH_API_KEY production    # paste the Datadash key; it never leaves Vercel
vercel deploy --prod
```

The endpoint is `https://<project>.vercel.app/api/mcp`. Check it:

```bash
curl -s -X POST https://<project>.vercel.app/api/mcp -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Then put that URL in the A2MCP entry of `listing/services.json`: the `endpoint` field and the `curl` in line 4 of
its `serviceDescription` must both use it. Run `onchainos agent validate-listing` before `onchainos agent update`.

Tests run with the main repo's `pnpm test` (`test/mcp-proxy.test.ts`).
