import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Datadash } from "../src/datadash.ts";
import type { HistoryItem } from "../src/state.ts";
import {
  fetchOutcomes,
  settledOutcomes,
  writeTrackRecord,
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

test("each position's outcome comes from the token on its latest fill", async () => {
  const asked: number[] = [];
  const datadash: Datadash = {
    list: async (endpoint, body) => {
      assert.equal(endpoint, "/api/v1/activity");
      const id = (body as { filter: { value: number[] }[] }).filter[0].value[0];
      asked.push(id);
      if (id === 3) return [];
      return [{ token: { positionId: id, tokenPrice: id === 1 ? 1 : 0.4, marketClosed: id === 1 } }];
    },
  };
  const { tokens: outcomes, failed } = await fetchOutcomes(datadash, [1, 2, 3, 1]);
  assert.equal(failed, 0);
  assert.deepEqual(asked.sort(), [1, 2, 3], "one request per position, duplicates dropped");
  assert.deepEqual(outcomes.get(1), { positionId: 1, tokenPrice: 1, marketClosed: true });
  assert.deepEqual(outcomes.get(2), { positionId: 2, tokenPrice: 0.4, marketClosed: false });
  assert.equal(outcomes.has(3), false, "no fills: left out, scores as unknown");
});

test("a failed lookup leaves that signal unknown; only a total failure throws", async () => {
  const flaky: Datadash = {
    list: async (_endpoint, body) => {
      const id = (body as { filter: { value: number[] }[] }).filter[0].value[0];
      if (id === 2) throw new Error("timeout");
      return [{ token: { positionId: id, tokenPrice: 0.5, marketClosed: false } }] as never;
    },
  };
  const { tokens, failed } = await fetchOutcomes(flaky, [1, 2]);
  assert.equal(failed, 1);
  assert.deepEqual([...tokens.keys()], [1]);

  const down: Datadash = { list: async () => { throw new Error("fetch failed"); } };
  await assert.rejects(fetchOutcomes(down, [1, 2]), /every outcome lookup failed/);
  assert.equal((await fetchOutcomes(down, [])).failed, 0, "nothing to look up is not a failure");
});

test("settled signals are reused from the previous report instead of looked up again", async () => {
  const dir = await mkdtemp(join(tmpdir(), "track-record-"));
  await writeFile(
    join(dir, "track-record.json"),
    JSON.stringify({ signals: [{ id: "1", status: "won" }, { id: "2", status: "lost" }, { id: "3", status: "open" }] }),
  );
  const settled = await settledOutcomes(join(dir, "track-record.json"));
  assert.deepEqual([...settled.entries()], [
    [1, { positionId: 1, tokenPrice: 1, marketClosed: true }],
    [2, { positionId: 2, tokenPrice: 0, marketClosed: true }],
  ]);

  const asked: number[] = [];
  const datadash: Datadash = {
    list: async (_endpoint, body) => {
      asked.push((body as { filter: { value: number[] }[] }).filter[0].value[0]);
      return [];
    },
  };
  const record = await writeTrackRecord(datadash, [item("1", 0.5), item("2", 0.5), item("3", 0.5)], dir);
  assert.deepEqual(asked, [3], "only the open signal is looked up");
  assert.equal(record.won, 1);
  assert.equal(record.resolved, 2);
  assert.equal((await settledOutcomes(join(dir, "missing.json"))).size, 0);
});
