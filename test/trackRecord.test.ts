import assert from "node:assert/strict";
import { test } from "node:test";
import type { HistoryItem } from "../src/state.ts";
import {
  renderTrackRecord,
  scoreHistory,
  type TokenOutcome,
} from "../src/trackRecord.ts";

const item = (id: string, orderPrice: number): HistoryItem => ({
  id,
  question: `Market ${id}?`,
  outcome: "No",
  orderPrice,
  settlement: "2026-12-31",
  url: `https://polymarket.com/event/e/m${id}`,
  text: "【Prediction】…",
  createdAt: `2026-09-2${id}T12:00:00.000Z`,
});
const tokens = (...list: TokenOutcome[]) =>
  new Map(list.map((t) => [t.positionId, t]));

test("settled signals are scored at the order price; open ones are marked to market but left out of totals", () => {
  const record = scoreHistory(
    [item("1", 0.8), item("2", 0.5), item("3", 0.6), item("4", 0.4)],
    tokens(
      { positionId: 1, tokenPrice: 0.9995, marketClosed: true },
      { positionId: 2, tokenPrice: 0.0005, marketClosed: true },
      { positionId: 3, tokenPrice: 0.66, marketClosed: false },
    ),
  );
  assert.deepEqual(
    record.signals.map((s) => s.status),
    ["won", "lost", "open", "unknown"],
  );
  assert.equal(record.signals[0].return, 0.25);
  assert.equal(record.signals[1].return, -1);
  assert.ok(Math.abs(record.signals[2].return! - 0.1) < 1e-9);
  assert.equal(record.resolved, 2);
  assert.equal(record.won, 1);
  assert.equal(record.avgReturn, -0.375);
  assert.equal(record.pnlPer100, -75);
});

test("a closed market still trading between 0 and 1 is settling, not lost", () => {
  const record = scoreHistory(
    [item("1", 0.8)],
    tokens({ positionId: 1, tokenPrice: 0.5, marketClosed: true }),
  );
  assert.equal(record.signals[0].status, "open");
  assert.equal(record.avgReturn, null);
});

test("the page lists newest first with totals", () => {
  const md = renderTrackRecord(
    scoreHistory(
      [item("1", 0.8), item("2", 0.5)],
      tokens(
        { positionId: 1, tokenPrice: 1, marketClosed: true },
        { positionId: 2, tokenPrice: 0.55, marketClosed: false },
      ),
    ),
    new Date("2026-09-23T12:00:00Z"),
  );
  assert.match(md, /Settled: \*\*1\*\*, won \*\*1\*\* \(100%\)/);
  assert.match(md, /\$100 on every settled signal: \*\*\+\$25\*\*/);
  assert.ok(md.indexOf("Market 2?") < md.indexOf("Market 1?"));
});
