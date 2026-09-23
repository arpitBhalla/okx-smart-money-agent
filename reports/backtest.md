# Backtest: following the Datadash Polymarket Analytics signals

Window: 2026-03-27 to 2026-09-23 (180 days), generated 2026-09-23 18:50 UTC.

## The answer

Staking **$100 on every signal** the rules would have sent, a follower would have made **$1,548** on the 615 resolved signals actually delivered ($994 on all 681 resolved signals before the delivery caps).

|  | Resolved signals | Hit rate | Avg entry | Avg return per signal (± 1 s.e.) | P&L at $100 each | Max drawdown | Median days to resolve |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| As delivered (caps on) | 615 | 66.5% | 0.65 | +2.5% ± 3.6% | $1,548 | $2,514 | 4.8 |
| All signals | 681 | 66.1% | 0.65 | +1.5% ± 3.4% | $994 | $2,674 | 4.5 |

"Avg entry" is the average price paid, which is roughly the win rate the market already priced in; the hit rate above it is the edge. Not yet settled: 57 signals still open (marked at today's prices: $356 at $100 each), 2 closed at an unclear price. These are not in the numbers above.

**Is the edge real?** Before the caps the average return is 0.4 standard errors from zero, and that is before the look-ahead bias below, which can only push it up. 43.9% of resolved signals are sports, most settling within hours of the buy, where a follower's price can differ from the trader's by more than the 1¢ assumed here. On the 642 signals that took a day or more to settle, the average return is +1.5% ± 3.5%. Read this as "the signals roughly paid for themselves, with a thin and uncertain edge", not as a promised return.

## By time from signal to settlement (all signals)

| | Resolved | Hit rate | Avg entry | Avg return | P&L at $100 each |
| --- | ---: | ---: | ---: | ---: | ---: |
| under 2 hours | 3 | 100.0% | 0.61 | +74.2% | $223 |
| 2 to 6 hours | 16 | 75.0% | 0.74 | -0.9% | -$14 |
| 6 to 24 hours | 20 | 60.0% | 0.66 | -8.7% | -$173 |
| 1 to 7 days | 372 | 66.9% | 0.66 | +1.0% | $378 |
| over 7 days | 270 | 64.4% | 0.63 | +2.1% | $580 |

## By entry price (all signals)

| | Resolved | Hit rate | Avg entry | Avg return | P&L at $100 each |
| --- | ---: | ---: | ---: | ---: | ---: |
| 0.10–0.30 | 44 | 18.2% | 0.22 | -10.0% | -$441 |
| 0.30–0.50 | 99 | 42.4% | 0.41 | +2.9% | $286 |
| 0.50–0.70 | 203 | 60.1% | 0.61 | -1.3% | -$258 |
| 0.70–0.85 | 304 | 81.6% | 0.79 | +3.3% | $1,018 |
| 0.85–0.90 | 31 | 96.8% | 0.86 | +12.5% | $388 |

## By category (all signals)

| | Resolved | Hit rate | Avg entry | Avg return | P&L at $100 each |
| --- | ---: | ---: | ---: | ---: | ---: |
| Sports | 299 | 65.2% | 0.62 | +7.8% | $2,343 |
| Crypto | 145 | 69.7% | 0.73 | -9.3% | -$1,348 |
| Geopolitics | 120 | 61.7% | 0.64 | -8.4% | -$1,010 |
| Politics | 48 | 66.7% | 0.62 | +2.5% | $119 |
| Other | 45 | 68.9% | 0.65 | +10.8% | $487 |
| Culture | 12 | 66.7% | 0.54 | +16.8% | $201 |
| Esports | 10 | 70.0% | 0.69 | +10.7% | $107 |
| Economy | 2 | 100.0% | 0.71 | +47.4% | $95 |

## 10 biggest wins

| Date | Market | Bet | Entry | Top trader's buy | Result |
| --- | --- | --- | ---: | ---: | ---: |
| 2026-05-16 | Will the New York Knicks win the 2026 NBA Finals? | Yes | 0.15 | $10,000 | won, $567 |
| 2026-06-22 | Will England vs. Ghana end in a draw? | Yes | 0.15 | $10,000 | won, $567 |
| 2026-03-29 | Will Spain win the 2026 FIFA World Cup? | Yes | 0.17 | $80,290 | won, $488 |
| 2026-06-04 | Will WTI Crude Oil (WTI) hit (LOW) $75 in June? | Yes | 0.19 | $14,821 | won, $426 |
| 2026-05-20 | US x Iran permanent peace deal by June 15, 2026? | Yes | 0.21 | $7,491 | won, $376 |
| 2026-03-27 | US x Iran ceasefire by April 15? | Yes | 0.28 | $17,898 | won, $257 |
| 2026-06-28 | Will Germany win on 2026-06-29? | No | 0.29 | $18,165 | won, $245 |
| 2026-05-08 | Fight to Go the Distance? | Yes | 0.30 | $12,000 | won, $233 |
| 2026-05-05 | Jerome Powell out as Fed Chair by May 15, 2026? | Yes | 0.31 | $8,215 | won, $223 |
| 2026-07-13 | Will Argentina win on 2026-07-15? | Yes | 0.32 | $12,477 | won, $213 |

## 10 biggest losses

Every loss costs the full $100 stake; these are the largest top-trader bets that lost.

| Date | Market | Bet | Entry | Top trader's buy | Result |
| --- | --- | --- | ---: | ---: | ---: |
| 2026-07-12 | Will France vs. Spain end in a draw? | Yes | 0.31 | $150,000 | lost, -$100 |
| 2026-04-03 | Will Finland win Eurovision 2026? | Yes | 0.38 | $133,539 | lost, -$100 |
| 2026-07-03 | Will England win on 2026-07-05? | No | 0.62 | $129,343 | lost, -$100 |
| 2026-07-02 | Will Belgium win on 2026-07-06? | No | 0.66 | $124,595 | lost, -$100 |
| 2026-07-13 | Will Spain win on 2026-07-14? | No | 0.72 | $119,144 | lost, -$100 |
| 2026-08-10 | Will Kai and Speed beat the Minecraft challenge by August 17? | No | 0.86 | $84,574 | lost, -$100 |
| 2026-06-16 | Will Portugal win the 2026 FIFA World Cup? | Yes | 0.12 | $84,000 | lost, -$100 |
| 2026-06-15 | Will Iran close its airspace by July 15? | No | 0.81 | $79,714 | lost, -$100 |
| 2026-06-13 | Will Côte d'Ivoire win on 2026-06-14? | No | 0.74 | $73,000 | lost, -$100 |
| 2026-07-03 | Will Brazil vs. Norway end in a draw? | Yes | 0.27 | $72,682 | lost, -$100 |

## Method and limits

- **Rules replayed.** Every buy of $5,000+ at 0.1–0.85 by a wallet ranked top 500 (119,237 fills from 309 wallets), grouped per wallet and outcome. A signal fires at the first buy where the wallet's total on that outcome is at least $5,000 and 3x its usual bet, the fill price is in the band, and the market ends in 1 to 120 days. One signal per outcome; once a market has fired, its other side never does.
- **Look-ahead bias: ranks are today's.** Datadash only exposes each wallet's current all-time rank, so the wallets replayed are the ones that are top 500 now, partly because of the very trades being tested. This flatters the result, and there is no way to remove it from this data.
- **Rules not replayed.** The live product also requires a Datadash signal score of 80+, that most top-500 money on the market agrees (Datadash's globalSmartMoney), and that a top trader bought within the last 7 days; the first two can't be rebuilt for the past, and the third holds by construction at the trigger. The price-vs-entry band (+3¢ / −10¢) isn't tested either, because the follower's entry is taken from the trader's own fill.
- **Fills under $5,000 are ignored.** A position built from many small buys never counts, and cumulative size only adds up the large fills.
- **Entry at the trader's fill + 1¢.** The live order is a limit at the current price + 1¢. There is no model of whether that limit would have filled, or of how far the price moved in the minutes before the signal went out.
- **Usual bet size is approximated.** Datadash's own figure (the one behind relSize) was available for 53 wallets; for the other 256 it is estimated as the wallet's all-time average cost per closed position × 0.188, a factor fitted on the wallets where both are known. The estimate is rough (typically within 2-3x). With the size rule switched off (still only for wallets with a size estimate), the replay gives 821 resolved signals, 65.0% hit rate, +1.5% per signal.
- **Delivery caps are approximate.** Rounds every 2 minutes, at most 3 per round (largest bets first, since there is no score), and at most one signal per event and per lead wallet in any 2 hours. Signals that don't fit are dropped; the live program instead retries them in a later round if they still qualify.
- **Sports end dates.** Polymarket sets many game markets' end date days after the game, so "ends in 1 or more days" lets in-play bets through (the live rule reads the same end date). 43.9% of resolved signals are sports.
- **Resolution.** A closed market's outcome token at 1 is a win (payout $1 per share), at 0 a loss. Return per signal = payout / entry − 1. No fees. Drawdown follows the order markets resolved in.

Per-signal rows: `reports/backtest.json`.
