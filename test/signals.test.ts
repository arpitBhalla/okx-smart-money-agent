import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSignals, settlementDate } from "../src/signals.ts";
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
