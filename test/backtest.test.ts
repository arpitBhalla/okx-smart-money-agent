import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyDeliveryCaps,
  buildBacktestSignals,
  category,
  formatReport,
  outcomeOf,
  summarize,
  usualSizes,
  type BacktestSignal,
  type Fill,
  type OutcomeToken,
  type UsualSize,
  runBacktest,
} from "../src/backtest.ts";
import type { Datadash } from "../src/datadash.ts";
import { thresholds } from "./fixtures.ts";

const WALLET = "0xaaa0000000000000000000000000000000000001";

const fill = (over: Partial<Fill> = {}): Fill => ({
  wallet: WALLET,
  positionId: 1,
  marketId: 10,
  eventId: 100,
  timestamp: "2026-06-01 12:00:00",
  usdPrice: 0.4,
  usdAmount: 20_000,
  tagIds: ["2"],
  ...over,
});

const outcome = (over: Partial<OutcomeToken> = {}): OutcomeToken => ({
  positionId: 1,
  marketQuestion: "Will the Fed cut rates in July?",
  marketSlug: "fed-cut-july",
  eventSlug: "fed-july",
  tokenName: "Yes",
  tokenPrice: 1,
  marketClosed: true,
  marketClosedTime: "2026-06-11 12:00:00",
  marketEndDate: "2026-06-30 00:00:00",
  ...over,
});

const tokens = (...items: OutcomeToken[]) =>
  new Map(items.map((item) => [item.positionId, item]));

/** Usual size $5,000: a $20,000 buy is 4x, above the 3x rule. */
const usual = (
  entries: [string, number][] = [[WALLET, 5000]],
): Map<string, UsualSize> =>
  new Map(entries.map(([wallet, usd]) => [wallet, { usd, source: "datadash" }]));

test("a single big buy triggers a signal and a win pays 1 / entry - 1", () => {
  const [signal] = buildBacktestSignals([fill()], tokens(outcome()), usual(), thresholds);
  assert.equal(signal.status, "won");
  assert.equal(signal.entryPrice, 0.41);
  assert.ok(Math.abs(signal.return - (1 / 0.41 - 1)) < 1e-9);
  assert.equal(signal.relSize, 4);
  assert.equal(signal.daysToResolution, 10);
  assert.equal(signal.category, "Politics");
});

test("a loss returns -100% and an open market is marked at today's price", () => {
  const [lost] = buildBacktestSignals(
    [fill()],
    tokens(outcome({ tokenPrice: 0 })),
    usual(),
    thresholds,
  );
  assert.equal(lost.status, "lost");
  assert.equal(lost.return, -1);

  const [open] = buildBacktestSignals(
    [fill()],
    tokens(outcome({ marketClosed: false, tokenPrice: 0.82, marketClosedTime: null })),
    usual(),
    thresholds,
  );
  assert.equal(open.status, "open");
  assert.ok(Math.abs(open.return - (0.82 / 0.41 - 1)) < 1e-9);
  assert.equal(open.resolvedAt, null);
});

test("size adds up across fills: the signal fires on the fill that crosses 3x", () => {
  const signals = buildBacktestSignals(
    [
      fill({ usdAmount: 6000, timestamp: "2026-06-01 10:00:00", usdPrice: 0.3 }),
      fill({ usdAmount: 6000, timestamp: "2026-06-01 11:00:00", usdPrice: 0.35 }),
      fill({ usdAmount: 6000, timestamp: "2026-06-01 12:00:00", usdPrice: 0.5 }),
    ],
    tokens(outcome()),
    usual([[WALLET, 4000]]),
    thresholds,
  );
  assert.equal(signals.length, 1);
  assert.equal(signals[0].fillPrice, 0.35);
  assert.equal(signals[0].leadUsd, 12_000);
});

test("no signal below the usual-size rule, outside 1..maxDaysLeft days, or without a usual size", () => {
  const none = (fills: Fill[], token = outcome(), sizes = usual()) =>
    assert.equal(buildBacktestSignals(fills, tokens(token), sizes, thresholds).length, 0);
  none([fill({ usdAmount: 10_000 })]); // 2x
  none([fill({ timestamp: "2026-06-29 12:00:00" })]); // 12 hours left
  none([fill({ timestamp: "2026-01-01 00:00:00" })]); // 180 days left
  none([fill()], outcome({ marketEndDate: null }));
  none([fill()], outcome(), new Map());
  none([fill({ usdPrice: 0.95 })]);
});

test("later wallets on the same outcome agree; the opposite side of a signalled market is skipped", () => {
  const second = "0xbbb";
  const signals = buildBacktestSignals(
    [
      fill(),
      fill({ wallet: second, timestamp: "2026-06-02 12:00:00" }),
      fill({ wallet: second, positionId: 2, timestamp: "2026-06-01 13:00:00" }),
    ],
    tokens(outcome(), outcome({ positionId: 2, tokenName: "No", tokenPrice: 0 })),
    usual([
      [WALLET, 5000],
      [second, 5000],
    ]),
    thresholds,
  );
  assert.equal(signals.length, 1);
  assert.equal(signals[0].positionId, 1);
  assert.equal(signals[0].agreeing, 1);
});

test("delivery caps: one per event and per lead wallet per 2 hours, at most 3 per round, biggest first", () => {
  const signal = (over: Partial<BacktestSignal>): BacktestSignal =>
    ({
      positionId: 1,
      eventId: 1,
      wallet: "w1",
      signalAt: "2026-06-01T12:01:00.000Z",
      leadUsd: 10_000,
      ...over,
    }) as BacktestSignal;
  const delivered = applyDeliveryCaps([
    signal({ positionId: 1, eventId: 1, wallet: "w1" }),
    // same event, 1 hour later: skipped
    signal({ positionId: 2, eventId: 1, wallet: "w2", signalAt: "2026-06-01T13:01:00.000Z" }),
    // same wallet, 3 hours later: allowed
    signal({ positionId: 3, eventId: 2, wallet: "w1", signalAt: "2026-06-01T15:01:00.000Z" }),
    // five in one round: the three biggest go
    ...[4, 5, 6, 7, 8].map((id) =>
      signal({ positionId: id, eventId: id, wallet: `x${id}`, signalAt: "2026-06-02T12:03:00.000Z", leadUsd: id * 1000 }),
    ),
  ]);
  assert.deepEqual(
    delivered.map((s) => s.positionId),
    [1, 3, 8, 7, 6],
  );
});

test("summary: hit rate, P&L at $100, drawdown in resolution order, open kept apart", () => {
  const s = (status: BacktestSignal["status"], ret: number, resolvedAt: string | null, entry = 0.5) =>
    ({ status, return: ret, resolvedAt, entryPrice: entry, daysToResolution: 2 }) as BacktestSignal;
  const summary = summarize([
    s("won", 1, "2026-06-01T00:00:00Z"),
    s("lost", -1, "2026-06-02T00:00:00Z"),
    s("lost", -1, "2026-06-03T00:00:00Z"),
    s("won", 1, "2026-06-04T00:00:00Z"),
    s("open", 0.5, null),
  ]);
  assert.equal(summary.resolved, 4);
  assert.equal(summary.hitRate, 0.5);
  assert.equal(summary.pnl, 0);
  assert.equal(summary.maxDrawdown, 200);
  assert.equal(summary.open, 1);
  assert.equal(summary.openMarkPnl, 50);
  assert.equal(summary.medianDaysToResolution, 2);
});

test("outcome and category labels", () => {
  assert.equal(outcomeOf(outcome({ tokenPrice: 0.5 })).status, "unclear");
  assert.equal(outcomeOf(outcome({ tokenPrice: 0.995 })).status, "won");
  assert.equal(category(["1", "2"]), "Sports");
  assert.equal(category([100265, 2]), "Geopolitics");
  assert.equal(category(["999"]), "Other");
});

test("usual size: Datadash's figure wins, others are the profile average times the fitted ratio", () => {
  const { sizes, calibration } = usualSizes(
    new Map([
      ["a", 1000],
      ["b", 3000],
    ]),
    new Map([
      ["a", { realizedBuyCost: 10_000, positions: 1 }],
      ["b", { realizedBuyCost: 10_000, positions: 1 }],
      ["c", { realizedBuyCost: 50_000, positions: 10 }],
    ]),
  );
  assert.equal(calibration, 0.2);
  assert.deepEqual(sizes.get("a"), { usd: 1000, source: "datadash" });
  assert.deepEqual(sizes.get("c"), { usd: 1000, source: "estimate" });
});

test("the report leads with the answer and lists its limits", () => {
  const all = buildBacktestSignals([fill()], tokens(outcome()), usual(), thresholds);
  const report = formatReport({
    generatedAt: "2026-09-23T00:00:00.000Z",
    days: 180,
    from: "2026-03-27",
    to: "2026-09-23",
    thresholds,
    options: { entryPremium: 0.01, extraSlippage: 0 },
    caps: { perRound: 3, roundMinutes: 10, cooldownHours: 2 },
    fills: 1,
    wallets: 1,
    usualSize: { datadashWallets: 1, estimateWallets: 0, calibration: 0.2 },
    all,
    delivered: all,
    withoutSizeRule: all,
  });
  assert.match(report, /\$144/);
  assert.match(report, /Look-ahead bias/);
  assert.match(report, /Rules not replayed/);
  assert.match(report, /globalSmartMoney/);
});

test("fills and their outcome tokens both come from the REST activity rows", async () => {
  const token = {
    positionId: 7,
    marketId: 10,
    eventId: 100,
    tagIds: ["2", "103149"],
    marketQuestion: "Will X happen?",
    marketSlug: "will-x-happen",
    eventSlug: "x",
    tokenName: "Yes",
    tokenPrice: 1,
    marketClosed: true,
    marketClosedTime: "2026-09-22 10:00:00",
    marketEndDate: "2026-09-22 10:00:00",
  };
  const fill = {
    txHash: "0xt",
    seqId: 1,
    timestamp: "2026-09-21 10:00:00",
    usdPrice: 0.4,
    usdAmount: 9000,
    user: { userId: "0xaaa" },
    token,
    market: { id: 10 },
    event: { id: 100 },
    // The API leaves a null where a tag is hidden from the public lookup; categories must not depend on it.
    tags: [{ id: 2 }, null],
  };
  const datadash: Datadash = {
    list: async (endpoint) => (endpoint === "/api/v1/activity" ? [fill, fill] : []) as never,
  };
  const data = await runBacktest(datadash, thresholds, 1, Date.parse("2026-09-22T12:00:00Z"));
  assert.equal(data.fills.length, 1, "the same fill twice is counted once");
  assert.deepEqual(data.fills[0], {
    wallet: "0xaaa",
    positionId: 7,
    marketId: 10,
    eventId: 100,
    timestamp: "2026-09-21 10:00:00",
    usdPrice: 0.4,
    usdAmount: 9000,
    tagIds: ["2", "103149"],
  });
  assert.equal(data.tokens.get(7)?.marketClosed, true);
});

test("like the live agent, the backtest only signals YES/NO outcomes", () => {
  assert.equal(
    buildBacktestSignals([fill()], tokens(outcome({ tokenName: "Real Madrid" })), usual(), thresholds).length,
    0,
  );
  assert.equal(buildBacktestSignals([fill()], tokens(outcome({ tokenName: "no" })), usual(), thresholds).length, 1);
});
