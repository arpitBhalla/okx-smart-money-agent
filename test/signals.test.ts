import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyConsensus,
  buildSignals,
  lastBuys,
  settlementDate,
  signalQuery,
  type ConsensusRow,
} from "../src/signals.ts";
import { row, thresholds, token, trader } from "./fixtures.ts";

const tokens = (...items: ReturnType<typeof token>[]) =>
  new Map(items.map((item) => [item.positionId, item]));
const traders = (...items: ReturnType<typeof trader>[]) =>
  new Map(items.map((item) => [item.userId, item]));

test("one position becomes one signal with the trader resolved", () => {
  const [signal] = buildSignals(
    [row()],
    tokens(token()),
    traders(trader()),
    thresholds,
  );
  assert.equal(signal.id, "1");
  assert.equal(signal.outcome, "No");
  assert.equal(signal.settlement, "2026-12-31");
  assert.equal(signal.traders[0].name, "JnStrtPrdctnMrkts");
  assert.equal(signal.traders[0].rank, 237);
});

test("two top traders in the same outcome are grouped into one signal", () => {
  const second = "0xbbb0000000000000000000000000000000000002";
  const signals = buildSignals(
    [row(), row({ userId: second, tradeSize: 50_000, avgEntryPrice: 0.4 })],
    tokens(token()),
    traders(
      trader(),
      trader({
        userId: second,
        displayName: null,
        pseudonym: "Quiet-Whale",
        rank: 12,
      }),
    ),
    thresholds,
  );
  assert.equal(signals.length, 1);
  assert.deepEqual(
    signals[0].traders.map((t) => t.name),
    ["Quiet-Whale", "JnStrtPrdctnMrkts"],
  );
  assert.equal(signals[0].positionPct, 3);
});

test("a market where top traders hold both sides is dropped", () => {
  const signals = buildSignals(
    [row(), row({ positionId: 2, userId: "0xbbb" })],
    tokens(token(), token({ positionId: 2, tokenName: "Yes" })),
    traders(trader()),
    thresholds,
  );
  assert.equal(signals.length, 0);
});

test("closed markets and positions without token info are skipped", () => {
  assert.equal(
    buildSignals(
      [row()],
      tokens(token({ marketClosed: true })),
      traders(),
      thresholds,
    ).length,
    0,
  );
  assert.equal(
    buildSignals([row()], new Map(), traders(), thresholds).length,
    0,
  );
});

test("the limit price is one cent over the market but never more than maxChase over the traders entry", () => {
  const [cheap] = buildSignals(
    [row({ avgEntryPrice: 0.41, pNow: 0.42 })],
    tokens(token()),
    traders(),
    thresholds,
  );
  assert.equal(cheap.orderPrice, 0.43);
  const [chased] = buildSignals(
    [row({ avgEntryPrice: 0.4, pNow: 0.43 })],
    tokens(token()),
    traders(),
    thresholds,
  );
  assert.equal(chased.orderPrice, 0.43);
});

test("an unknown wallet falls back to a shortened address", () => {
  const [signal] = buildSignals(
    [row()],
    tokens(token()),
    traders(),
    thresholds,
  );
  assert.equal(signal.traders[0].name, "0xaaa0…0001");
  assert.equal(signal.traders[0].rank, null);
});

test("signals are ranked by score, then by how many top traders agree", () => {
  const signals = buildSignals(
    [
      row({ positionId: 1, marketId: 1, score: 90 }),
      row({ positionId: 2, marketId: 2, score: 100 }),
      row({ positionId: 3, marketId: 3, score: 100 }),
      row({ positionId: 3, marketId: 3, score: 95, userId: "0xccc" }),
    ],
    tokens(
      token({ positionId: 1 }),
      token({ positionId: 2 }),
      token({ positionId: 3 }),
    ),
    traders(),
    thresholds,
  );
  assert.deepEqual(
    signals.map((s) => s.id),
    ["3", "2", "1"],
  );
});

test("settlement is the last Eastern-time trading day, not the UTC close", () => {
  assert.equal(settlementDate("2027-01-01 05:00:00"), "2026-12-31");
  assert.equal(settlementDate("2026-11-01 03:59:00"), "2026-10-31");
  assert.equal(settlementDate(null), null);
  assert.equal(settlementDate("not a date"), null);
});

test("the query drops positions that fell more than maxDrop below the traders entry", () => {
  const slips = signalQuery(thresholds).filter.filter(
    (f) => f.field === "slipAbs",
  );
  assert.deepEqual(
    slips.map((f) => [f.operator, f.value]),
    [
      ["lte", 0.03],
      ["gte", -0.1],
    ],
  );
});

test("an old holding is skipped unless a trader on it traded within maxPositionAgeDays", () => {
  const now = new Date("2026-09-23T12:00:00Z");
  const second = "0xbbb0000000000000000000000000000000000002";
  const rows = [row(), row({ userId: second })];
  const build = (lastTraded: [string, string][]) =>
    buildSignals(rows, tokens(token()), traders(trader()), thresholds, {
      lastTraded: new Map(lastTraded),
      now,
    });

  assert.equal(build([]).length, 0, "no trade record: not news");
  assert.equal(
    build([[`${row().userId}:1`, "2026-09-10 12:00:00"]]).length,
    0,
    "13 days old",
  );
  const [signal] = build([
    [`${row().userId}:1`, "2026-09-10 12:00:00"],
    [`${second}:1`, "2026-09-21 12:00:00"],
  ]);
  assert.ok(signal, "one trader traded it 2 days ago");
  assert.deepEqual(
    signal.traders.map((t) => t.lastTradedAt).sort(),
    ["2026-09-10 12:00:00", "2026-09-21 12:00:00"],
  );
});

test("a stale holder on the other side still blocks the market", () => {
  const now = new Date("2026-09-23T12:00:00Z");
  const signals = buildSignals(
    [row(), row({ positionId: 2, userId: "0xbbb" })],
    tokens(token(), token({ positionId: 2, tokenName: "Yes" })),
    traders(),
    thresholds,
    {
      lastTraded: new Map([[`${row().userId}:1`, "2026-09-22 12:00:00"]]),
      now,
    },
  );
  assert.equal(signals.length, 0);
});

test("a signal needs the top wallets' money to lean its way across enough wallets", () => {
  const consensus = (over: Partial<ConsensusRow> = {}): ConsensusRow => ({
    marketId: 10,
    side: "No",
    smartMoneyPrice: 0.81,
    wallets: 15,
    atRisk: 243_000,
    ...over,
  });
  const [base] = buildSignals([row()], tokens(token()), traders(trader()), thresholds);

  const [kept] = applyConsensus([base], [consensus()], thresholds);
  assert.deepEqual(kept.consensus, { share: 0.81, wallets: 15, atRiskUsd: 243_000 });

  assert.equal(applyConsensus([base], [consensus({ side: "Yes" })], thresholds).length, 0, "money leans the other way");
  assert.equal(applyConsensus([base], [consensus({ side: "no" })], thresholds).length, 1, "side names match case-insensitively");
  assert.equal(applyConsensus([base], [consensus({ smartMoneyPrice: 0.55 })], thresholds).length, 0, "too split");
  assert.equal(applyConsensus([base], [consensus({ wallets: 2 })], thresholds).length, 0, "a lone whale and a friend");
  assert.equal(applyConsensus([base], [], thresholds).length, 0, "no consensus row");
});

test("freshness counts buys only, keeps the latest, and fails loudly on bad data", () => {
  const last = lastBuys([
    { wallet: "0xa", positionId: 1, timestamp: "2026-09-20 10:00:00" },
    { wallet: "0xa", positionId: 1, timestamp: "2026-09-22 10:00:00" },
    { wallet: "0xb", positionId: 2, timestamp: "2026-09-21 10:00:00" },
  ]);
  assert.equal(last.get("0xa:1"), "2026-09-22 10:00:00");
  assert.equal(last.get("0xb:2"), "2026-09-21 10:00:00");
  assert.throws(() => lastBuys([{ wallet: "0xa", positionId: 1 }]), /without wallet or timestamp/);
  assert.throws(
    () => lastBuys(Array.from({ length: 1000 }, () => ({ wallet: "0xa", positionId: 1, timestamp: "2026-09-22 10:00:00" }))),
    /full page/,
  );
});
