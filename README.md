# Datadash Smart Money on OKX.AI

**Follow Polymarket's best traders from any OKX agent.**

Datadash tracks every Polymarket wallet. This agent watches the 500 most profitable ones and sends a signal
when one of them makes an unusually big bet. On OKX.AI it is a subscription service: a monthly fee with a
3-day free trial. Subscribers' agents receive each signal and, if the subscriber turns copy-trading on, place
the same bet through OKX's Polymarket plugin for the amount the subscriber chose.

OKX Dev Day 2026, **Build a Company** track.

## How it works

```
Datadash (every Polymarket wallet, scored)
        │  every 10 minutes: top-500 traders' new high-conviction positions
        ▼
Resident delivery program (this repo, `pnpm start`)
        │  onchainos agent subscribe-active   → who is subscribed right now
        │  onchainos agent deliver <jobId>    → one 【Prediction】 signal per new position
        ▼
OKX.AI subscription (escrow and settlement on X Layer)
        │
        ▼
Subscriber's agent
        │  copy-trading on?  polymarket-plugin buy, limited to the subscriber's amount
        ▼
Order on Polymarket (Polygon)
```

The agent's identity, the subscription, the payments and the trade execution all run on OKX's own rails:
Agentic Wallet, the OKX.AI subscription contract, and the Onchain OS Polymarket plugin. This repo contributes
the part only Datadash has: knowing which trades are worth following.

## When a signal fires

A position qualifies when all of these hold (every threshold can be changed in `.env`):

| Rule                                | Default           | Why                                                        |
| ----------------------------------- | ----------------- | ---------------------------------------------------------- |
| Trader rank by all-time PnL         | top 500           | Proven traders only                                        |
| Datadash signal score               | 80 or more        | Datadash's 0-100 conviction score                          |
| Size against the trader's usual bet | 3x or more        | An unusual bet, not routine activity                       |
| Money behind it                     | $5,000 or more    | Real conviction                                            |
| Current price                       | 10¢ to 90¢        | Enough upside, and odds that aren't a coin flip on nothing |
| Price against the trader's entry    | at most 3¢ higher | The signal is still copyable                               |
| Days until the market ends          | 1 to 120          | Settles in a useful time frame                             |

Several top traders in the same outcome become **one** signal. A market where top traders hold opposite sides is
skipped, because there is no clear side to follow. Each signal fires once, at most 3 per round, strongest first.

A signal is one line in OKX.AI's Prediction format, at most 200 characters:

```
【Prediction】"Will Bitcoin reach $120,000 by December 31, 2026?" | NO | Limit | Order Price 0.86 | Position 3% | Settlement 2026-12-31 | Valid for 2h
```

The limit price is one cent above the current price, but never more than 3 cents above what the top traders
paid. The position is 3% when the score is 95 or more and either several top traders agree or the bet is 10x
the trader's usual size, otherwise 2%.

## Run it

Needs Node 22.18 or newer (it runs the TypeScript directly) and pnpm.

```bash
pnpm install
cp .env.example .env          # add DATADASH_API_KEY, and OKX_ASP_AGENT_ID once registered
pnpm preview                  # the signals that qualify right now, with the reason for each. Changes nothing.
pnpm test                     # unit tests
```

| Command         | What it does                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------ |
| `pnpm preview`  | Prints the signals that qualify now. Read-only.                                                  |
| `pnpm baseline` | Marks everything that qualifies now as seen, so only positions opened from here on fire.         |
| `pnpm round`    | One round: find new signals, deliver them to every active subscriber. `DRY_RUN=1` sends nothing. |
| `pnpm start`    | The resident delivery program: a round every `SCAN_INTERVAL_MIN` minutes.                        |

State (signals seen, the outbox, what each subscriber received) lives in `data/state.json`.

## Put it on OKX.AI

1. **Install Onchain OS and log in** on the server that will run the agent, with the email that owns the seller
   identity:
   ```bash
   npx -y @okxweb3/onchainos-installer install
   ```
   Then log in to the Agentic Wallet from your agent (Claude Code or Codex) and let the okx-ai skill run the
   `agent pre-check --role asp` consent step.
2. **Register the agent**, with the avatar, the profile in `listing/agent.json` and the services in
   `listing/services.json`. Ask the agent to "register as an ASP" and give it those files; the okx-ai skill
   walks the flow and runs `onchainos agent create`. Add the free A2MCP services (`/smart-money-edge`,
   `/market-read`) from the `okx-a2mcp` Worker to the same identity, so subscribers can try the data first.
   If the identity already exists, add this service with `onchainos agent update` instead.
3. **Submit for listing review.** OKX reviews within 48 hours and emails the result.
4. **Start delivery** on the same server:
   ```bash
   pnpm baseline   # optional: skip positions that already qualify today
   sudo cp deploy/okx-smart-money-agent.service /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now okx-smart-money-agent
   ```
5. **Keep an agent session open** on that server (Claude Code with the okx-ai skill, plus `skill/SKILL.md` from
   this repo). OKX requires the provider's own agent to accept each new subscription (`sub_open`). The resident
   program only delivers signals; it never accepts or declines anything.

## Decisions for the team

- **Price.** 5 USDT a month with a 3-day free trial. OKX blocks a price of 0 on subscriptions. Change it with `onchainos agent update`.
- **Seller identity email.** Use a shared company inbox: review results and the payout wallet are tied to it.

## Layout

```
src/signals.ts     Datadash query, grouping and ranking of signals
src/format.ts      The 【Prediction】 line (max 200 characters) and the human-readable reason
src/dispatch.ts    One round: admit new signals, deliver to each active subscription, retry failures
src/onchainos.ts   The onchainos CLI calls: gate-check, subscribe-active, deliver
src/datadash.ts    Datadash MCP client (api.datadash.xyz/mcp, X-Api-Key header)
src/cli.ts         preview / baseline / round / run
listing/           OKX.AI identity and service listing
skill/SKILL.md     Instructions for the provider's agent session
deploy/            systemd unit for the resident program
```

Signals are information, not financial advice. Copy-trading is off unless each subscriber turns it on.
