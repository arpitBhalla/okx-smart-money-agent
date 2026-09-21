import { mkdir, writeFile } from "node:fs/promises";
import type { Config, Thresholds } from "./config.ts";
import { createDatadash, readToken, type Datadash, type ListRow } from "./datadash.ts";
import { pool } from "./pool.ts";
import { isBinaryOutcome } from "./signals.ts";

/**
 * "If I had followed these signals, what would I have made?"
 *
 * The live product reads Datadash's signalScore table, which only holds positions top traders hold today, so
 * history has to be rebuilt from the activity trade log: every buy of $5k+ by a top-500 wallet, replayed in
 * order, with the live rules applied at each fill. The result is an approximation; the report says where.
 */

/** One buy from Datadash's activity table. */
export type Fill = {
  wallet: string;
  positionId: number;
  marketId: number;
  eventId: number;
  /** UTC, "2026-09-23 09:25:41". */
  timestamp: string;
  usdPrice: number;
  usdAmount: number;
  tagIds: (string | number)[];
};

/** The outcome token and its market's state today, from the token lookup. Closed markets are included. */
export type OutcomeToken = {
  positionId: number;
  marketQuestion: string;
  marketSlug: string;
  eventSlug: string;
  tokenName: string;
  /** For a closed market: about 1 if this outcome won, about 0 if it lost. */
  tokenPrice: number;
  marketClosed: boolean;
  marketClosedTime: string | null;
  marketEndDate: string | null;
};

export type SignalStatus = "won" | "lost" | "open" | "unclear";

export type BacktestSignal = {
  positionId: number;
  marketId: number;
  eventId: number;
  question: string;
  outcome: string;
  slug: string;
  eventSlug: string;
  category: string;
  /** The wallet whose buy triggered the signal. */
  wallet: string;
  /** ISO time of the triggering fill. */
  signalAt: string;
  /** What the top trader paid on the triggering fill. */
  fillPrice: number;
  /** What a follower is assumed to pay: fill price + 1¢ (+ any extra slippage), at most 0.99. */
  entryPrice: number;
  /** The wallet's cumulative USD bought on this outcome when the signal fired. */
  leadUsd: number;
  relSize: number;
  /** Whether the wallet's usual bet size came from Datadash itself or from the calibrated profile estimate. */
  usualSizeSource: UsualSize["source"];
  daysLeft: number;
  /** Other top wallets that later crossed the same thresholds on the same outcome. */
  agreeing: number;
  status: SignalStatus;
  /** Return per dollar staked: payout / entry - 1. For open or unclear markets, marked at today's price. */
  return: number;
  resolvedAt: string | null;
  daysToResolution: number | null;
};

export type UsualSize = {
  usd: number;
  /** "datadash": tradeSize / relSize from signalScore, exact. "estimate": calibrated userProfile average. */
  source: "datadash" | "estimate";
};

export type BuildOptions = {
  /** Price the follower pays above the trader's fill. The live order is priceNow + 1¢. */
  entryPremium: number;
  /** Extra price paid for the delay between the trader's fill and the follower's order. Default 0. */
  extraSlippage: number;
};

export const defaultBuildOptions: BuildOptions = {
  entryPremium: 0.01,
  extraSlippage: 0,
};

export type DeliveryCaps = {
  /** Most signals delivered in one round; the strongest (by USD behind it) go first, the rest are dropped. */
  perRound: number;
  roundMinutes: number;
  /** No second signal on the same event, or from the same lead wallet, within this many hours. */
  cooldownHours: number;
};

export const defaultDeliveryCaps: DeliveryCaps = {
  perRound: 3,
  roundMinutes: 10,
  cooldownHours: 2,
};

const DAY_MS = 86_400_000;
const round2 = (value: number) => Math.round(value * 100) / 100;

/** Datadash timestamps are UTC without a zone marker. */
export const utcMs = (timestamp: string) =>
  new Date(`${timestamp.replace(" ", "T")}Z`).getTime();

/**
 * Top-level category for the report. Events carry many tags ("Sports", "NBA", "Games"...); the first match in
 * this order wins, so a geopolitics event also tagged Politics counts as Geopolitics. Ids checked against the
 * Datadash tag lookup.
 */
const CATEGORIES: [string, string][] = [
  ["64", "Esports"],
  ["1", "Sports"],
  ["21", "Crypto"],
  ["100265", "Geopolitics"],
  ["2", "Politics"],
  ["100328", "Economy"],
  ["596", "Culture"],
];

export function category(tagIds: (string | number)[]): string {
  const tags = new Set(tagIds.map(String));
  return CATEGORIES.find(([id]) => tags.has(id))?.[1] ?? "Other";
}

/**
 * Win, loss, or not settled yet. Only a closed market whose token sits at (about) 1 or 0 counts as settled;
 * a closed market at 0.5 (a 50-50 resolution, or a stale price) is "unclear" and kept out of the headline.
 */
export function outcomeOf(token: OutcomeToken): {
  status: SignalStatus;
  payout: number;
} {
  const price = Number(token.tokenPrice);
  if (!token.marketClosed) return { status: "open", payout: price };
  if (price >= 0.99) return { status: "won", payout: 1 };
  if (price <= 0.01) return { status: "lost", payout: 0 };
  return { status: "unclear", payout: price };
}

/** The follower's price: the live order goes in one cent above the current price, which here is the trader's fill. */
export function followerEntry(fillPrice: number, options: BuildOptions) {
  return Math.min(
    0.99,
    round2(fillPrice + options.entryPremium + options.extraSlippage),
  );
}

type Trigger = { fill: Fill; leadUsd: number; relSize: number; usual: UsualSize; daysLeft: number };

/**
 * The first fill at which one wallet's position meets every live rule except the Datadash score, which cannot be
 * rebuilt for the past. Size is cumulative: three $5k buys on the same outcome count as one $15k bet.
 */
function firstTrigger(
  fills: Fill[],
  token: OutcomeToken,
  usual: UsualSize | undefined,
  t: Thresholds,
): Trigger | undefined {
  if (!usual || !(usual.usd > 0)) return undefined;
  const endMs = token.marketEndDate ? utcMs(token.marketEndDate) : NaN;
  let leadUsd = 0;
  for (const fill of fills) {
    leadUsd += fill.usdAmount;
    const relSize = leadUsd / usual.usd;
    const daysLeft = (endMs - utcMs(fill.timestamp)) / DAY_MS;
    if (
      leadUsd >= t.minTradeUsd &&
      relSize >= t.minRelSize &&
      fill.usdPrice >= t.minPrice &&
      fill.usdPrice <= t.maxPrice &&
      daysLeft >= 1 &&
      daysLeft <= t.maxDaysLeft
    )
      return { fill, leadUsd, relSize, usual, daysLeft };
  }
  return undefined;
}

/**
 * Replays the trade log into the signals the live rules would have sent, oldest first. One signal per outcome
 * token: the first wallet to qualify leads, later ones count as agreeing. Once a market has a signal, the other
 * side of that market never fires, which mirrors the live rule of skipping markets where top traders disagree.
 */
export function buildBacktestSignals(
  fills: Fill[],
  tokens: Map<number, OutcomeToken>,
  usualSize: Map<string, UsualSize>,
  t: Thresholds,
  options: BuildOptions = defaultBuildOptions,
): BacktestSignal[] {
  const byWalletPosition = new Map<string, Fill[]>();
  for (const fill of fills) {
    const token = tokens.get(fill.positionId);
    // Same rule as live: only YES/NO outcomes can become signals.
    if (!token || !isBinaryOutcome(token.tokenName)) continue;
    const key = `${fill.wallet}:${fill.positionId}`;
    byWalletPosition.set(key, [...(byWalletPosition.get(key) ?? []), fill]);
  }

  const triggers: Trigger[] = [];
  for (const group of byWalletPosition.values()) {
    group.sort((a, b) => utcMs(a.timestamp) - utcMs(b.timestamp));
    const token = tokens.get(group[0].positionId)!;
    const trigger = firstTrigger(group, token, usualSize.get(group[0].wallet), t);
    if (trigger) triggers.push(trigger);
  }
  triggers.sort((a, b) => utcMs(a.fill.timestamp) - utcMs(b.fill.timestamp));

  const byPosition = new Map<number, BacktestSignal>();
  const positionPerMarket = new Map<number, number>();
  for (const { fill, leadUsd, relSize, usual, daysLeft } of triggers) {
    const existing = byPosition.get(fill.positionId);
    if (existing) {
      existing.agreeing += 1;
      continue;
    }
    const taken = positionPerMarket.get(fill.marketId);
    if (taken !== undefined && taken !== fill.positionId) continue;
    positionPerMarket.set(fill.marketId, fill.positionId);

    const token = tokens.get(fill.positionId)!;
    const { status, payout } = outcomeOf(token);
    const entryPrice = followerEntry(fill.usdPrice, options);
    const signalMs = utcMs(fill.timestamp);
    const resolvedMs =
      status === "won" || status === "lost"
        ? utcMs(token.marketClosedTime ?? token.marketEndDate ?? "")
        : NaN;
    const resolved = Number.isFinite(resolvedMs);
    byPosition.set(fill.positionId, {
      positionId: fill.positionId,
      marketId: fill.marketId,
      eventId: fill.eventId,
      question: token.marketQuestion,
      outcome: token.tokenName,
      slug: token.marketSlug,
      eventSlug: token.eventSlug,
      category: category(fill.tagIds),
      wallet: fill.wallet,
      signalAt: new Date(signalMs).toISOString(),
      fillPrice: fill.usdPrice,
      entryPrice,
      leadUsd: Math.round(leadUsd),
      relSize: round2(relSize),
      usualSizeSource: usual.source,
      daysLeft: round2(daysLeft),
      agreeing: 0,
      status,
      return: payout / entryPrice - 1,
      resolvedAt: resolved ? new Date(resolvedMs).toISOString() : null,
      daysToResolution: resolved
        ? round2(Math.max(0, resolvedMs - signalMs) / DAY_MS)
        : null,
    });
  }
  return [...byPosition.values()];
}

/**
 * The signals a subscriber would actually have received: rounds every roundMinutes, at most perRound per round
 * (largest bets first; the live ranking uses the Datadash score, which the past doesn't have), and no repeat on
 * the same event or from the same lead wallet within cooldownHours. Overflow is dropped, not carried over,
 * because the backtest has no price for a later round.
 */
export function applyDeliveryCaps(
  signals: BacktestSignal[],
  caps: DeliveryCaps = defaultDeliveryCaps,
): BacktestSignal[] {
  const roundMs = caps.roundMinutes * 60_000;
  const cooldownMs = caps.cooldownHours * 3_600_000;
  const rounds = new Map<number, BacktestSignal[]>();
  for (const signal of signals) {
    const round = Math.floor(Date.parse(signal.signalAt) / roundMs);
    rounds.set(round, [...(rounds.get(round) ?? []), signal]);
  }

  const lastByEvent = new Map<number, number>();
  const lastByWallet = new Map<string, number>();
  const delivered: BacktestSignal[] = [];
  for (const round of [...rounds.keys()].sort((a, b) => a - b)) {
    const at = (round + 1) * roundMs;
    const recent = (last: number | undefined) =>
      last !== undefined && at - last < cooldownMs;
    let sent = 0;
    for (const signal of rounds
      .get(round)!
      .sort((a, b) => b.leadUsd - a.leadUsd)) {
      if (sent >= caps.perRound) break;
      if (recent(lastByEvent.get(signal.eventId))) continue;
      if (recent(lastByWallet.get(signal.wallet))) continue;
      lastByEvent.set(signal.eventId, at);
      lastByWallet.set(signal.wallet, at);
      delivered.push(signal);
      sent += 1;
    }
  }
  return delivered;
}

export type Summary = {
  signals: number;
  resolved: number;
  wins: number;
  hitRate: number;
  /** Mean follower entry price: roughly the win rate the market priced in. */
  avgEntry: number;
  avgReturn: number;
  /** Standard error of avgReturn, so a reader can tell edge from noise. */
  avgReturnStdErr: number;
  /** Total P&L staking $100 on every resolved signal. */
  pnl: number;
  /** Largest peak-to-trough fall of that P&L, ordered by resolution time. */
  maxDrawdown: number;
  medianDaysToResolution: number | null;
  open: number;
  /** Open signals marked at today's price, $100 each. Not in the headline. */
  openMarkPnl: number;
  unclear: number;
};

export const STAKE = 100;

const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export function isResolved(signal: BacktestSignal) {
  return signal.status === "won" || signal.status === "lost";
}

export function summarize(signals: BacktestSignal[]): Summary {
  const resolved = signals
    .filter(isResolved)
    .sort((a, b) => Date.parse(a.resolvedAt!) - Date.parse(b.resolvedAt!));
  const open = signals.filter((signal) => signal.status === "open");
  const n = resolved.length;
  const returns = resolved.map((signal) => signal.return);
  const avgReturn = n ? returns.reduce((sum, r) => sum + r, 0) / n : 0;
  const variance =
    n > 1
      ? returns.reduce((sum, r) => sum + (r - avgReturn) ** 2, 0) / (n - 1)
      : 0;

  let pnl = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const r of returns) {
    pnl += STAKE * r;
    peak = Math.max(peak, pnl);
    maxDrawdown = Math.max(maxDrawdown, peak - pnl);
  }

  const wins = resolved.filter((signal) => signal.status === "won").length;
  return {
    signals: signals.length,
    resolved: n,
    wins,
    hitRate: n ? wins / n : 0,
    avgEntry: n
      ? resolved.reduce((sum, signal) => sum + signal.entryPrice, 0) / n
      : 0,
    avgReturn,
    avgReturnStdErr: n ? Math.sqrt(variance / n) : 0,
    pnl,
    maxDrawdown,
    medianDaysToResolution: median(
      resolved.map((signal) => signal.daysToResolution ?? 0),
    ),
    open: open.length,
    openMarkPnl: open.reduce((sum, signal) => sum + STAKE * signal.return, 0),
    unclear: signals.filter((signal) => signal.status === "unclear").length,
  };
}

/** Buckets on the trader's fill price, which is the price the live rules test. */
export const PRICE_BUCKETS: [number, number][] = [
  [0.1, 0.3],
  [0.3, 0.5],
  [0.5, 0.7],
  [0.7, 0.85],
  [0.85, 0.9],
];

export function byPriceBucket(signals: BacktestSignal[]) {
  return PRICE_BUCKETS.map(([low, high], i) => ({
    label: `${low.toFixed(2)}–${high.toFixed(2)}`,
    summary: summarize(
      signals.filter(
        (signal) =>
          signal.fillPrice >= low &&
          (signal.fillPrice < high ||
            (i === PRICE_BUCKETS.length - 1 && signal.fillPrice <= high)),
      ),
    ),
  }));
}

/**
 * How long after the signal the market settled. Most sports markets carry an end date days after the game, so
 * the 1-day rule doesn't stop in-play bets; this split shows how much of the result comes from them.
 */
export const RESOLUTION_BUCKETS: [string, number, number][] = [
  ["under 2 hours", 0, 2],
  ["2 to 6 hours", 2, 6],
  ["6 to 24 hours", 6, 24],
  ["1 to 7 days", 24, 168],
  ["over 7 days", 168, Infinity],
];

export function byTimeToResolution(signals: BacktestSignal[]) {
  return RESOLUTION_BUCKETS.map(([label, low, high]) => ({
    label,
    summary: summarize(
      signals.filter((signal) => {
        const hours = (signal.daysToResolution ?? -1) * 24;
        return isResolved(signal) && hours >= low && hours < high;
      }),
    ),
  }));
}

export function byCategory(signals: BacktestSignal[]) {
  const names = [...new Set(signals.map((signal) => signal.category))];
  return names
    .map((label) => ({
      label,
      summary: summarize(signals.filter((signal) => signal.category === label)),
    }))
    .filter((row) => row.summary.resolved > 0)
    .sort((a, b) => b.summary.resolved - a.summary.resolved);
}

export type ReportInput = {
  generatedAt: string;
  days: number;
  from: string;
  to: string;
  thresholds: Thresholds;
  options: BuildOptions;
  caps: DeliveryCaps;
  fills: number;
  wallets: number;
  /** Signals whose lead wallet's usual size came from Datadash, versus the estimate. */
  usualSize: { datadashWallets: number; estimateWallets: number; calibration: number };
  all: BacktestSignal[];
  delivered: BacktestSignal[];
  /** Same replay with the size rule off: shows how much the usual-size approximation matters. */
  withoutSizeRule: BacktestSignal[];
};

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const usd = (value: number) =>
  `${value < 0 ? "-" : ""}$${Math.round(Math.abs(value)).toLocaleString("en-US")}`;
const signedPct = (value: number) =>
  `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
const cell = (text: string) => text.replace(/\|/g, "/");

function headlineRow(label: string, s: Summary) {
  return `| ${label} | ${s.resolved} | ${pct(s.hitRate)} | ${s.avgEntry.toFixed(2)} | ${signedPct(s.avgReturn)} ± ${pct(s.avgReturnStdErr)} | ${usd(s.pnl)} | ${usd(s.maxDrawdown)} | ${s.medianDaysToResolution?.toFixed(1) ?? "–"} |`;
}

const HEADLINE_HEADER = `|  | Resolved signals | Hit rate | Avg entry | Avg return per signal (± 1 s.e.) | P&L at $100 each | Max drawdown | Median days to resolve |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`;

function breakdown(rows: { label: string; summary: Summary }[]) {
  return [
    "| | Resolved | Hit rate | Avg entry | Avg return | P&L at $100 each |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...rows.map(
      ({ label, summary: s }) =>
        `| ${label} | ${s.resolved} | ${s.resolved ? pct(s.hitRate) : "–"} | ${s.resolved ? s.avgEntry.toFixed(2) : "–"} | ${s.resolved ? signedPct(s.avgReturn) : "–"} | ${usd(s.pnl)} |`,
    ),
  ].join("\n");
}

function signalTable(signals: BacktestSignal[]) {
  return [
    "| Date | Market | Bet | Entry | Top trader's buy | Result |",
    "| --- | --- | --- | ---: | ---: | ---: |",
    ...signals.map(
      (s) =>
        `| ${s.signalAt.slice(0, 10)} | ${cell(s.question)} | ${cell(s.outcome)} | ${s.entryPrice.toFixed(2)} | ${usd(s.leadUsd)} | ${s.status === "won" ? "won" : "lost"}, ${usd(STAKE * s.return)} |`,
    ),
  ].join("\n");
}

/** The one-minute read for a judge: the answer first, then where it comes from and what it can't tell you. */
export function formatReport(input: ReportInput): string {
  const all = summarize(input.all);
  const delivered = summarize(input.delivered);
  const noSize = summarize(input.withoutSizeRule);
  const resolved = input.all.filter(isResolved);
  const wins = resolved
    .filter((s) => s.status === "won")
    .sort((a, b) => b.return - a.return || b.leadUsd - a.leadUsd)
    .slice(0, 10);
  const losses = resolved
    .filter((s) => s.status === "lost")
    .sort((a, b) => b.leadUsd - a.leadUsd)
    .slice(0, 10);
  const t = input.thresholds;
  const zScore = all.avgReturnStdErr ? all.avgReturn / all.avgReturnStdErr : 0;
  const slow = summarize(
    input.all.filter((s) => isResolved(s) && (s.daysToResolution ?? 0) >= 1),
  );
  const sports = input.all.filter((s) => isResolved(s) && s.category === "Sports").length;

  return `# Backtest: following the Datadash Polymarket Analytics signals

Window: ${input.from} to ${input.to} (${input.days} days), generated ${input.generatedAt.slice(0, 16).replace("T", " ")} UTC.

## The answer

Staking **$100 on every signal** the rules would have sent, a follower would have made **${usd(delivered.pnl)}** on the ${delivered.resolved} resolved signals actually delivered (${usd(all.pnl)} on all ${all.resolved} resolved signals before the delivery caps).

${HEADLINE_HEADER}
${headlineRow("As delivered (caps on)", delivered)}
${headlineRow("All signals", all)}

"Avg entry" is the average price paid, which is roughly the win rate the market already priced in; the hit rate above it is the edge. Not yet settled: ${all.open} signals still open (marked at today's prices: ${usd(all.openMarkPnl)} at $100 each), ${all.unclear} closed at an unclear price. These are not in the numbers above.

**Is the edge real?** Before the caps the average return is ${(zScore).toFixed(1)} standard errors from zero, and that is before the look-ahead bias below, which can only push it up. ${pct(sports / Math.max(1, all.resolved))} of resolved signals are sports, most settling within hours of the buy, where a follower's price can differ from the trader's by more than the 1¢ assumed here. On the ${slow.resolved} signals that took a day or more to settle, the average return is ${signedPct(slow.avgReturn)} ± ${pct(slow.avgReturnStdErr)}. Read this as "the signals roughly paid for themselves, with a thin and uncertain edge", not as a promised return.

## By time from signal to settlement (all signals)

${breakdown(byTimeToResolution(input.all))}

## By entry price (all signals)

${breakdown(byPriceBucket(input.all))}

## By category (all signals)

${breakdown(byCategory(input.all))}

## 10 biggest wins

${signalTable(wins)}

## 10 biggest losses

Every loss costs the full $100 stake; these are the largest top-trader bets that lost.

${signalTable(losses)}

## Method and limits

- **Rules replayed.** Every buy of $${t.minTradeUsd.toLocaleString("en-US")}+ at ${t.minPrice}–${t.maxPrice} by a wallet ranked top ${t.maxTraderRank} (${input.fills.toLocaleString("en-US")} fills from ${input.wallets} wallets), grouped per wallet and outcome. A signal fires at the first buy where the wallet's total on that outcome is at least $${t.minTradeUsd.toLocaleString("en-US")} and ${t.minRelSize}x its usual bet, the fill price is in the band, and the market ends in 1 to ${t.maxDaysLeft} days. One signal per outcome; once a market has fired, its other side never does.
- **Look-ahead bias: ranks are today's.** Datadash only exposes each wallet's current all-time rank, so the wallets replayed are the ones that are top ${t.maxTraderRank} now, partly because of the very trades being tested. This flatters the result, and there is no way to remove it from this data.
- **Rules not replayed.** The live product also requires a Datadash signal score of ${t.minScore}+, that most top-500 money on the market agrees (Datadash's globalSmartMoney), and that a top trader bought within the last ${t.maxPositionAgeDays} days; the first two can't be rebuilt for the past, and the third holds by construction at the trigger. The price-vs-entry band (+${Math.round(t.maxChase * 100)}¢ / −${Math.round(t.maxDrop * 100)}¢) isn't tested either, because the follower's entry is taken from the trader's own fill.
- **Fills under $${t.minTradeUsd.toLocaleString("en-US")} are ignored.** A position built from many small buys never counts, and cumulative size only adds up the large fills.
- **Entry at the trader's fill + ${Math.round(input.options.entryPremium * 100)}¢${input.options.extraSlippage ? ` + ${Math.round(input.options.extraSlippage * 100)}¢ delay slippage` : ""}.** The live order is a limit at the current price + 1¢. There is no model of whether that limit would have filled, or of how far the price moved in the minutes before the signal went out.
- **Usual bet size is approximated.** Datadash's own figure (the one behind relSize) was available for ${input.usualSize.datadashWallets} wallets; for the other ${input.usualSize.estimateWallets} it is estimated as the wallet's all-time average cost per closed position × ${input.usualSize.calibration.toFixed(3)}, a factor fitted on the wallets where both are known. The estimate is rough (typically within 2-3x). With the size rule switched off (still only for wallets with a size estimate), the replay gives ${noSize.resolved} resolved signals, ${pct(noSize.hitRate)} hit rate, ${signedPct(noSize.avgReturn)} per signal.
- **Delivery caps are approximate.** Rounds every ${input.caps.roundMinutes} minutes, at most ${input.caps.perRound} per round (largest bets first, since there is no score), and at most one signal per event and per lead wallet in any ${input.caps.cooldownHours} hours. Signals that don't fit are dropped; the live program instead retries them in a later round if they still qualify.
- **Sports end dates.** Polymarket sets many game markets' end date days after the game, so "ends in 1 or more days" lets in-play bets through (the live rule reads the same end date). ${pct(sports / Math.max(1, all.resolved))} of resolved signals are sports.
- **Resolution.** A closed market's outcome token at 1 is a win (payout $1 per share), at 0 a loss. Return per signal = payout / entry − 1. No fees. Drawdown follows the order markets resolved in.

Per-signal rows: \`reports/backtest.json\`.
`;
}

const log = (line: string) =>
  console.log(`${new Date().toISOString()} ${line}`);

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Runs tasks a few at a time: fast enough for 180 days of pages, gentle enough on the API. */
const chunks = <T>(items: T[], size: number) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, i * size + size),
  );

/**
 * Every qualifying buy in the window. The API caps a page at 1000 rows, so the window is split into two-day
 * slices (about 750 rows each) and each slice is paged. The date range is inclusive on both ends.
 */
async function fetchFills(
  datadash: Datadash,
  t: Thresholds,
  fromMs: number,
  toMs: number,
): Promise<{ fills: Fill[]; tokens: Map<number, OutcomeToken> }> {
  const slices: [string, string][] = [];
  for (let start = fromMs; start <= toMs; start += 2 * DAY_MS)
    slices.push([isoDay(start), isoDay(Math.min(start + DAY_MS, toMs))]);

  let done = 0;
  const pages = await pool(slices, 3, async ([from, to]) => {
    const rows: ListRow<"/api/v1/activity">[] = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await datadash.list("/api/v1/activity", {
        activities: ["Buy"],
        filter: [
          { field: "userRank", operator: "lte", value: t.maxTraderRank },
          { field: "usdAmount", operator: "gte", value: t.minTradeUsd },
          { field: "usdPrice", operator: "gte", value: t.minPrice },
          { field: "usdPrice", operator: "lte", value: t.maxPrice },
          { field: "timestamp", operator: "between", value: { from, to } },
        ],
        orderBy: [
          { field: "timestamp", direction: "asc" },
          { field: "seqId", direction: "asc" },
        ],
        page: { limit: 1000, offset },
      });
      rows.push(...page);
      if (page.length < 1000) break;
    }
    done += 1;
    if (done % 10 === 0 || done === slices.length)
      log(`fills: ${done}/${slices.length} two-day slices fetched`);
    return rows;
  });

  // Each fill carries its outcome token, filled in by the API with its live price and closed flag, so the tokens
  // come from the fills themselves rather than a separate lookup.
  const seen = new Set<string>();
  const fills: Fill[] = [];
  const tokens = new Map<number, OutcomeToken>();
  let skipped = 0;
  for (const row of pages.flat()) {
    const wallet = row.user?.userId;
    const token = readToken(row.token);
    const marketId = row.market?.id ?? token?.marketId;
    const eventId = row.event?.id ?? token?.eventId;
    // One incomplete row out of tens of thousands must not throw away the whole run: skip it and say so.
    if (!wallet || !token || marketId == null || eventId == null) {
      skipped += 1;
      continue;
    }
    const key = `${row.txHash}:${row.seqId}:${wallet}:${token.positionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tokens.set(token.positionId, token);
    fills.push({
      wallet,
      positionId: token.positionId,
      marketId,
      eventId,
      timestamp: String(row.timestamp),
      usdPrice: Number(row.usdPrice),
      usdAmount: Number(row.usdAmount),
      // The token's own id list, not `tags`: `tags` has a null where a tag is hidden from the public lookup.
      tagIds: token.tagIds,
    });
  }
  if (skipped) log(`fills: skipped ${skipped} row(s) without a trader, token or market`);
  return { fills, tokens };
}

/** A wallet's typical cost per position, from its all-time profile. Scaled to Datadash's figure by calibration. */
export const profileAverage = (profile: {
  realizedBuyCost: number;
  positions: number;
}) =>
  profile.positions > 0 ? profile.realizedBuyCost / profile.positions : NaN;

/**
 * Datadash's own usual bet size where it has one (tradeSize / relSize is the same on all of a wallet's rows), and
 * for the rest an estimate: the profile average times the median ratio between the two on wallets that have both.
 */
export function usualSizes(
  exact: Map<string, number>,
  profiles: Map<string, { realizedBuyCost: number; positions: number }>,
): { sizes: Map<string, UsualSize>; calibration: number } {
  const ratios: number[] = [];
  for (const [wallet, usd] of exact) {
    const profile = profiles.get(wallet);
    const average = profile ? profileAverage(profile) : NaN;
    if (average > 0) ratios.push(usd / average);
  }
  const calibration = median(ratios) ?? 1;

  const sizes = new Map<string, UsualSize>();
  for (const [wallet, profile] of profiles) {
    const average = profileAverage(profile);
    if (average > 0)
      sizes.set(wallet, { usd: average * calibration, source: "estimate" });
  }
  for (const [wallet, usd] of exact)
    if (usd > 0) sizes.set(wallet, { usd, source: "datadash" });
  return { sizes, calibration };
}

async function fetchUsualSizes(
  datadash: Datadash,
  t: Thresholds,
  wallets: string[],
) {
  const exact = new Map<string, number>();
  for (let offset = 0; ; offset += 1000) {
    const rows = await datadash.list("/api/v1/signals/scores", {
      filter: [{ field: "userRank", operator: "lte", value: t.maxTraderRank }],
      orderBy: [{ field: "tradeSize", direction: "desc" }],
      page: { limit: 1000, offset },
    });
    for (const row of rows) {
      const tradeSize = Number(row.tradeSize);
      const relSize = Number(row.relSize);
      if (tradeSize > 0 && relSize > 0)
        if (row.user?.userId) exact.set(row.user.userId, tradeSize / relSize);
    }
    if (rows.length < 1000) break;
  }

  const profiles = new Map<string, { realizedBuyCost: number; positions: number }>();
  for (const batch of chunks(wallets, 1000)) {
    const rows = await datadash.list("/api/v1/profiles/user", {
      duration: { operator: "in", value: ["ALL"] },
      filter: [{ field: "userId", operator: "in", value: batch }],
      page: { limit: batch.length, offset: 0 },
    });
    for (const row of rows) {
      if (!row.user?.userId) continue;
      profiles.set(row.user.userId, {
        realizedBuyCost: Number(row.realizedBuyCost),
        positions: Number(row.positions),
      });
    }
  }
  log(
    `usual bet size: ${exact.size} wallet(s) from Datadash, ${profiles.size} all-time profile(s)`,
  );
  return usualSizes(exact, profiles);
}

export type BacktestData = {
  fills: Fill[];
  tokens: Map<number, OutcomeToken>;
  usualSize: Map<string, UsualSize>;
  calibration: number;
  from: string;
  to: string;
};

/** All the I/O: the trade log, the outcome of every token in it, and each wallet's usual bet size. */
export async function runBacktest(
  datadash: Datadash,
  t: Thresholds,
  days: number,
  now = Date.now(),
): Promise<BacktestData> {
  const fromMs = now - days * DAY_MS;
  log(`backtest: fetching top-trader buys from ${isoDay(fromMs)} to ${isoDay(now)}`);
  const { fills, tokens } = await fetchFills(datadash, t, fromMs, now);
  log(`fills: ${fills.length} buys fetched, ${tokens.size} outcome tokens`);
  const { sizes, calibration } = await fetchUsualSizes(datadash, t, [
    ...new Set(fills.map((fill) => fill.wallet)),
  ]);
  return {
    fills,
    tokens,
    usualSize: sizes,
    calibration,
    from: isoDay(fromMs),
    to: isoDay(now),
  };
}

/** Pure: from fetched data to the report input, so the numbers can be reproduced from saved data in tests. */
export function analyze(
  data: BacktestData,
  t: Thresholds,
  days: number,
  options: BuildOptions = defaultBuildOptions,
  caps: DeliveryCaps = defaultDeliveryCaps,
  generatedAt = new Date().toISOString(),
): ReportInput {
  const all = buildBacktestSignals(data.fills, data.tokens, data.usualSize, t, options);
  const wallets = new Set(data.fills.map((fill) => fill.wallet));
  const sources = [...wallets].map((wallet) => data.usualSize.get(wallet)?.source);
  return {
    generatedAt,
    days,
    from: data.from,
    to: data.to,
    thresholds: t,
    options,
    caps,
    fills: data.fills.length,
    wallets: wallets.size,
    usualSize: {
      datadashWallets: sources.filter((s) => s === "datadash").length,
      estimateWallets: sources.filter((s) => s === "estimate").length,
      calibration: data.calibration,
    },
    all,
    delivered: applyDeliveryCaps(all, caps),
    withoutSizeRule: buildBacktestSignals(
      data.fills,
      data.tokens,
      data.usualSize,
      { ...t, minRelSize: 0 },
      options,
    ),
  };
}

const envNumber = (name: string, fallback: number) => {
  const value = Number(process.env[name] ?? "");
  return process.env[name] && Number.isFinite(value) ? value : fallback;
};

/** `node src/cli.ts backtest [days]`: fetch, replay, write reports/backtest.md and .json, print the headline. */
export async function backtestCommand(config: Config): Promise<void> {
  const days = Number(process.argv[3]) || envNumber("BACKTEST_DAYS", 180);
  const options: BuildOptions = {
    ...defaultBuildOptions,
    extraSlippage: envNumber("BACKTEST_EXTRA_SLIPPAGE", 0),
  };
  const caps: DeliveryCaps = {
    perRound: config.maxSignalsPerRound,
    roundMinutes: config.scanIntervalMin,
    cooldownHours: config.signalValidHours,
  };

  const datadash = createDatadash(config.datadashApiUrl, config.datadashApiKey);
  const data = await runBacktest(datadash, config.thresholds, days);

  const input = analyze(data, config.thresholds, days, options, caps);
  const delivered = new Set(input.delivered.map((signal) => signal.positionId));
  await mkdir("reports", { recursive: true });
  await writeFile("reports/backtest.md", formatReport(input));
  await writeFile(
    "reports/backtest.json",
    `${JSON.stringify(
      {
        generatedAt: input.generatedAt,
        window: { from: input.from, to: input.to, days },
        thresholds: input.thresholds,
        options,
        caps,
        usualSize: input.usualSize,
        summary: {
          asDelivered: summarize(input.delivered),
          allSignals: summarize(input.all),
          withoutSizeRule: summarize(input.withoutSizeRule),
        },
        signals: input.all.map((signal) => ({
          ...signal,
          delivered: delivered.has(signal.positionId),
        })),
      },
      null,
      2,
    )}\n`,
  );

  const s = summarize(input.delivered);
  const a = summarize(input.all);
  log(
    `backtest done: as delivered, ${s.resolved} resolved signals, ${pct(s.hitRate)} hit rate, ` +
      `${signedPct(s.avgReturn)} per signal, ${usd(s.pnl)} at $100 each, max drawdown ${usd(s.maxDrawdown)}`,
  );
  log(
    `all signals: ${a.resolved} resolved, ${pct(a.hitRate)} hit rate, ${signedPct(a.avgReturn)} per signal, ${usd(a.pnl)}`,
  );
  log("report written to reports/backtest.md and reports/backtest.json");
}
