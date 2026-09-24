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
