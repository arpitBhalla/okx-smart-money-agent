# Demo script (2 to 4 minutes)

Two screens: the **buyer**, a Claude Code session with Onchain OS and a funded Agentic Wallet, and the
**provider**, the server running `pnpm start`. Record the buyer full screen; cut to the provider logs when
the signal goes out.

## Before recording

- The listing is approved and visible on OKX.AI.
- The resident program is running on the provider server, and the provider's agent session is open to accept
  the subscription (`sub_open`).
- The buyer wallet passes `polymarket-plugin check-access`, holds about $20 USDC.e on Polygon, and has the
  Polymarket plugin set up (`polymarket-plugin quickstart` reports `proxy_ready` or `active`).
- Run `pnpm preview` and note a signal that will fire. On the provider, keep it unseen (do **not** run
  `pnpm baseline`), so the first round after the subscription delivers it.

## Script

1. **The problem (15s).** "Polymarket's top traders make millions, and every trade they make is public. Nobody
   can watch 500 wallets. Datadash does."
2. **Find the agent (30s).** In the buyer session: _"Find a Polymarket smart money signal service on OKX.AI."_
   The agent finds **Datadash**: Polymarket Smart Money Signals, monthly with a 3-day free trial.
3. **Subscribe (45s).** _"Subscribe with the free trial."_ The agent walks our Service Guide: Polymarket is set
   up, copy-trading on, **$5 per order**. Confirm. The subscription is created on OKX.AI (escrow on X Layer).
4. **The signal arrives (45s).** Cut to the provider logs: `new signal ...` then `job ...: delivered`. On the
   buyer screen the signal appears, for example:
   `【Prediction】"Will Bitcoin reach $120,000 by December 31, 2026?" | NO | Limit | Order Price 0.86 | Position 3% | Settlement 2026-12-31 | Valid for 2h`
   Say why it fired, from the `pnpm preview` reason line: three top-500 traders hold $128K of No, one of them
   34x their usual size.
5. **Copy-trade (30s).** The buyer's agent places the $5 limit order through the Polymarket plugin. Open the
   transaction on Polygonscan and the position on Polymarket.
6. **Close (15s).** "Datadash on OKX.AI: follow Polymarket's best traders from any agent. Datadash finds the
   trades; OKX handles the subscription, the payment and the execution."

## If something goes wrong live

- No signal in the first round: run `pnpm round` on the provider by hand; it delivers anything still inside
  its 2-hour window.
- The order doesn't fill: the limit price is deliberately capped at 3 cents over the top traders' entry. Say
  so. That cap protects subscribers from chasing.
