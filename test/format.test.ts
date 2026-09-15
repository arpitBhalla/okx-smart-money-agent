import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_SIGNAL_LENGTH,
  explainSignal,
  formatSignal,
} from "../src/format.ts";
import { signal } from "./fixtures.ts";

test("matches the OKX.AI Prediction signal format", () => {
  assert.equal(
    formatSignal(signal(), 2),
    '【Prediction】"Will Ethereum dip to $2,250 by December 31, 2026?" | NO | Limit | Order Price 0.43 | Position 3% | Settlement 2026-12-31 | Valid for 2h',
  );
});

test("a long question is shortened so the signal stays within 200 characters", () => {
  const text = formatSignal(
    signal({ question: `Will ${"a very long clause ".repeat(20)}happen?` }),
    2,
  );
  assert.ok(text.length <= MAX_SIGNAL_LENGTH, `${text.length} characters`);
  assert.ok(
    text.length >= MAX_SIGNAL_LENGTH - 2,
    "the question uses the room it has",
  );
  assert.match(text, /…" \| NO \| Limit/);
});

test("a market without an end date leaves out Settlement", () => {
  assert.doesNotMatch(
    formatSignal(signal({ settlement: null }), 2),
    /Settlement/,
  );
});

test("the explanation names the trader, the size and the market link", () => {
  const text = explainSignal(signal());
  assert.match(
    text,
    /JnStrtPrdctnMrkts \(rank #237\) holds \$20\.0K of No at 0\.41/,
  );
  assert.match(text, /10\.0x their usual size/);
  assert.match(
    text,
    /polymarket\.com\/event\/what-price-will-ethereum-hit-in-2026\/will-ethereum-dip/,
  );
});
