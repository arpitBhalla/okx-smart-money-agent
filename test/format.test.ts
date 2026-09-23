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

test("the explanation says what a win pays and how recently a trader bought", () => {
  const text = explainSignal(signal(), new Date("2026-09-23T10:00:00Z"));
  assert.match(text, /Last bought 2d ago\./);
  assert.match(text, /Now 0\.42; pays \+133% if right\./);
});

test("the explanation shows the smart-money consensus behind the signal", () => {
  const text = explainSignal(
    signal({ consensus: { share: 0.81, wallets: 15, atRiskUsd: 243_000 } }),
  );
  assert.match(text, /Top-500 money on this side: 81% across 15 wallets \(\$243\.0K\)\./);
});

test("a lead trader's rank is shown only when it is inside the smart-money cut", () => {
  const lead = signal().traders[0];
  assert.match(explainSignal(signal()), /JnStrtPrdctnMrkts \(rank #237\) holds/);
  const outsider = signal({ traders: [{ ...lead, name: "0x8b4b…541b", rank: 3_207_727 }] });
  assert.match(explainSignal(outsider), /^0x8b4b…541b holds/);
  assert.match(explainSignal(signal(), new Date(), 100), /^JnStrtPrdctnMrkts holds/, "the cut follows maxTraderRank");
});
