# Datadash Polymarket Analytics on OKX.AI

**Follow Polymarket's best traders from any OKX agent.**

Datadash tracks every Polymarket wallet. This agent takes the 1,000 highest-scoring positions Datadash sees,
from any wallet, and sends a signal when one is an unusually big bet that the 500 most profitable traders agree
with. On OKX.AI it is a subscription service: a monthly fee with a
3-day free trial. Subscribers' agents receive each signal and, if the subscriber turns copy-trading on, place
the same bet through OKX's Polymarket plugin for the amount the subscriber chose.

OKX Dev Day 2026, **Build a Company** track.

## How it works

```
Datadash (every Polymarket wallet, scored)
        │  every 2 minutes: the 1,000 highest-scoring positions, from any wallet
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
| Candidates                          | top 1,000 by score, then bet size, any wallet | The score already weighs the wallet; consensus checks the rest |
| Datadash signal score               | 80 or more        | Datadash's 0-100 conviction score                          |
| Size against the trader's usual bet | 3x or more        | An unusual bet, not routine activity                       |
| Money behind it                     | $5,000 or more    | Real conviction                                            |
| Current price                       | 10¢ to 85¢        | About +16% or more if right, and odds that aren't a coin flip on nothing |
| Price against the trader's entry    | 3¢ higher to 10¢ lower | Still copyable, and the market isn't running against them |
| Last bought by a signalling trader  | within 7 days     | News, not an old holding                                   |
| Smart-money consensus               | 60%+ of top-500 money on the market, 3+ wallets, $10,000+ | The 500 most profitable traders agree, with real money; a lone whale is not enough |
| Days until the market ends          | 1 to 120          | Settles in a useful time frame                             |

Two Datadash views work together. The **trigger** is an unusual, high-scoring bet by any wallet (`signalScore`,
the top 1,000 by score; `MAX_TRIGGER_RANK` limits it to ranked traders if wanted): it gives the moment, the entry
price and the size. The **confirmation** is the smart-money consensus (`globalSmartMoney`,
evaluated over top-500 wallets only): of all the money those wallets hold on the market, most must be on the same
side. Consensus alone would repeat the same markets for weeks with no entry price to trade on; one trader alone
can be wrong or hedged elsewhere.

Only YES/NO outcomes qualify: OKX's Prediction format has no way to name a team or candidate. Several top traders in the same outcome become **one** signal. A market where top traders hold opposite sides is
skipped, because there is no clear side to follow. Each signal fires once, at most 3 per round, strongest first.
While a signal is live, its event and its traders get no other signal (`MAX_SIGNALS_PER_EVENT`,
`MAX_SIGNALS_PER_TRADER`): NO on "Bitcoin reaches $120K" and NO on "Bitcoin reaches $110K" from the same wallet
are one bet, and a copier should not take it twice. A signal held back waits for a later round.

A signal is one line in OKX.AI's Prediction format, at most 200 characters:

```
【Prediction】"Will Benjamin Netanyahu be the next Prime Minister of Israel?" | NO | Limit | Order Price 0.73 | Position 2% | Settlement 2026-10-27 | Valid for 2h
```

`Valid for` counts down: a subscriber who joins an hour after a signal fired receives `Valid for 1h`, and a
signal with under an hour left is not sent. The line carries no market id, because OKX's format has no field for one. The service guide tells the
subscriber's agent to match the exact question, outcome and settlement date, and to skip the signal rather than
guess when the match is not unique.

The limit price is one cent above the current price, but never more than 3 cents above what the top traders
paid. The position is 3% when the score is 95 or more and either several top traders agree or the bet is 10x
the trader's usual size, otherwise 2%.

## Run it

Needs Node 22.18 or newer (it runs the TypeScript directly) and pnpm.

```bash
pnpm install
cp .env.example .env          # add OKX_ASP_AGENT_ID once registered (DATADASH_API_KEY is optional)
pnpm preview                  # the signals that qualify right now, with the reason for each. Changes nothing.
pnpm test                     # unit tests
```

| Command         | What it does                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------ |
| `pnpm preview`  | Prints the signals that qualify now. Read-only.                                                  |
| `pnpm baseline` | Marks everything that qualifies now as seen, so only positions opened from here on fire.         |
| `pnpm round`    | One round: find new signals, deliver them to every active subscriber. `DRY_RUN=1` sends nothing. |
| `pnpm start`    | The resident delivery program: a round every `SCAN_INTERVAL_MIN` minutes.                        |
| `pnpm track-record` | Scores every signal sent so far against the market into `reports/track-record.md`.          |

State (signals seen, the outbox, what each subscriber received, every signal ever sent) lives in
`data/state.json`. After every round the resident program writes `data/health.json`, and it alerts through
`ALERT_WEBHOOK_URL` (Slack or Discord) when rounds fail 3 times in a row, when delivery recovers, and when a
subscription waits more than 15 minutes for the agent session to accept it.

## Backtest

`pnpm backtest` (or `pnpm backtest 90`) asks "what if I had followed every signal?" Datadash's live table only holds
positions held today, so the backtest replays the activity log instead: every $5k+ buy by a top-500 wallet on a
YES/NO market, run through the rules it can rebuild (size against the trader's usual bet, price band, days to end,
one side per market, the delivery caps), with the follower buying at the trader's price + 1¢ and $100 per signal.
Results go to `reports/backtest.md` (and per-signal rows to `reports/backtest.json`, not committed).

Run on 2026-09-23 over the previous 180 days, with the YES/NO-only rule:

|                        | Resolved signals | Hit rate | Avg entry | Avg return per signal | P&L at $100 each | Max drawdown |
| ---------------------- | ---------------: | -------: | --------: | --------------------: | ---------------: | -----------: |
| As delivered (caps on) |              615 |    66.5% |      0.65 |          +2.5% ± 3.6% |          +$1,548 |       $2,514 |
| All signals            |              681 |    66.1% |      0.65 |          +1.5% ± 3.4% |            +$994 |       $2,674 |

**What this says:** the replayed signals roughly broke even. The average return is well inside its error bar, so
there is no demonstrated edge from these rules alone. Entries between 0.10 and 0.30 lost 10% per signal; entries
between 0.70 and 0.85 made 3.3%. An earlier run that also counted team-name markets (mostly sports settling within
hours) looked stronger, at +4.4% over 3,782 signals; those markets can't be sent in OKX's YES/NO format, so they
are out.

**What it can't test**, and why the live product may do better or worse:

- The live trigger takes any wallet among Datadash's 1,000 top-scoring positions; the replay only has top-500
  wallets, ranked by today's leaderboard (look-ahead bias).
- The Datadash score and the smart-money consensus (60%+ of top-500 money, $10,000+) exist only for today's
  holdings, so the two main live filters are not in these numbers.
- A wallet's usual bet size is partly estimated, and there is no model of whether the follower's limit order fills.

The live track record (`pnpm track-record`) is the real test.

## Track record

`pnpm track-record` publishes every signal sent with its result: won or lost once the market settles, marked to
the current price while it is open. Returns are per dollar at the signal's order price. Run it on a schedule
and publish `reports/track-record.md` (for example on the Datadash site) so subscribers can check the record
before they pay.

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
   walks the flow and runs `onchainos agent create`. `listing/services.json` has two services: the A2A
   subscription, and a free A2MCP service so agents can try the data before subscribing. The A2MCP one needs no
   agent session: OKX's CLI calls the endpoint directly. Datadash's MCP requires an API key, so the endpoint is a
   small Vercel proxy (`mcp-proxy/`) that adds our key and exposes only the read-only tools. Deploy it first (see
   `mcp-proxy/README.md`) and put its URL in the A2MCP entry.
   If the identity already exists, add this service with `onchainos agent update` instead.
3. **Submit for listing review.** OKX reviews within 48 hours and emails the result.
4. **Start delivery** on the same server:
   ```bash
   pnpm baseline   # optional: skip positions that already qualify today
   sudo cp deploy/okx-smart-money-agent.service /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now okx-smart-money-agent
   ```
5. **Keep an agent session open** on that server (Claude Code with the okx-ai skill, plus `skill/SKILL.md` from
   this repo). OKX requires the provider's own agent to accept each new subscription (`sub_open`), and its rules
   forbid dispatchers from doing it. The resident program only delivers signals and watches: it alerts when a
   subscription waits too long, which means the session is down.

## Decisions for the team

- **Price.** 5 USDT a month with a 3-day free trial. OKX blocks a price of 0 on subscriptions. Change it with `onchainos agent update`.
- **Tiers (proposal, not listed yet).**
  | Tier     | Price            | What you get                                                                 |
  | -------- | ---------------- | ---------------------------------------------------------------------------- |
  | Free     | 0, via A2MCP     | Datadash's MCP tools through our proxy (`mcp-proxy/`): smart-money consensus, signal scores, wallet profiles |
  | Standard | 5 USDT a month   | This service: live signals, copy-trading through the subscriber's own agent  |
  | Pro      | 25 USDT a month  | 30-second scans, every qualifying signal (no per-round cap), a custom trader list, category filters |
  Pro is a second service on the same identity, added with `onchainos agent update` once Standard has a track record.
- **Where this grows.** The same scoring works on every prediction market Datadash indexes, and the Datadash
  score itself can be licensed to trading desks and other agents as an API.
- **Seller identity email.** Use a shared company inbox: review results and the payout wallet are tied to it.

## Layout

```
src/signals.ts     Datadash query, grouping and ranking of signals
src/format.ts      The 【Prediction】 line (max 200 characters) and the human-readable reason
src/dispatch.ts    One round: admit new signals, deliver to each active subscription, retry failures
src/onchainos.ts   The onchainos CLI calls: gate-check, subscribe-active, deliver, pending subscriptions (read-only)
src/datadash.ts    Datadash REST client (api.datadash.xyz/api/v1), typed from the OpenAPI spec
src/generated/     Types generated from openapi/datadash.json. Do not edit: run `pnpm gen:api`
openapi/           Pinned copy of https://docs.datadash.xyz/openapi.json. `pnpm update:api` refreshes it
src/health.ts      data/health.json after each round, and webhook alerts
src/trackRecord.ts Every signal sent, scored against the market
src/backtest.ts    Replay of past top-trader buys through the signal rules
src/cli.ts         preview / baseline / round / run / track-record / backtest
listing/           OKX.AI identity and service listing
skill/SKILL.md     Instructions for the provider's agent session
deploy/            systemd unit for the resident program
mcp-proxy/         Vercel function: the free A2MCP endpoint, a key-holding read-only proxy to Datadash's MCP
```

Signals are information, not financial advice. Copy-trading is off unless each subscriber turns it on.
