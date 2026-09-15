import assert from "node:assert/strict";
import { test } from "node:test";
import { runRound, type RoundOptions } from "../src/dispatch.ts";
import type { DeliverResult, Okx } from "../src/onchainos.ts";
import { emptyState } from "../src/state.ts";
import { signal } from "./fixtures.ts";

const opts = (over: Partial<RoundOptions> = {}): RoundOptions => ({
  aspAgentId: "42",
  maxSignalsPerRound: 3,
  signalValidHours: 2,
  dryRun: false,
  now: new Date("2026-09-22T12:00:00Z"),
  log: () => {},
  ...over,
});

function fakeOkx(
  jobs: string[],
  answer: (jobId: string, text: string) => DeliverResult = () => ({
    kind: "delivered",
  }),
) {
  const sent: { jobId: string; text: string }[] = [];
  const okx: Okx = {
    gateCheck: async () => ({ ready: true, detail: {} }),
    activeSubscriptions: async () => jobs,
    deliver: async (jobId, _agent, text) => {
      sent.push({ jobId, text });
      return answer(jobId, text);
    },
  };
  return { okx, sent };
}

test("a new signal goes to every active subscription once", async () => {
  const state = emptyState();
  const { okx, sent } = fakeOkx(["job-a", "job-b"]);
  const summary = await runRound(state, [signal()], okx, opts());
  assert.equal(summary.delivered, 2);
  assert.deepEqual(
    sent.map((s) => s.jobId),
    ["job-a", "job-b"],
  );

  const again = await runRound(state, [signal()], okx, opts());
  assert.equal(again.newSignals.length, 0);
  assert.equal(sent.length, 2, "nothing is re-sent");
});

test("a subscriber who joins later still gets signals inside the validity window", async () => {
  const state = emptyState();
  await runRound(state, [signal()], fakeOkx([]).okx, opts());

  const { okx, sent } = fakeOkx(["late-job"]);
  await runRound(
    state,
    [],
    okx,
    opts({ now: new Date("2026-09-22T13:00:00Z") }),
  );
  assert.equal(sent.length, 1);

  const { okx: later, sent: tooLate } = fakeOkx(["later-job"]);
  await runRound(
    state,
    [],
    later,
    opts({ now: new Date("2026-09-22T14:30:00Z") }),
  );
  assert.equal(tooLate.length, 0, "expired signals are not sent");
});

test("a failed send is retried next round; alreadyDelivered counts as done", async () => {
  const state = emptyState();
  let fail = true;
  const { okx, sent } = fakeOkx(["job-a"], () =>
    fail
      ? { kind: "failed", message: "sendFailed" }
      : { kind: "alreadyDelivered" },
  );
  const first = await runRound(state, [signal()], okx, opts());
  assert.equal(first.failed, 1);

  fail = false;
  await runRound(state, [], okx, opts());
  await runRound(state, [], okx, opts());
  assert.equal(sent.length, 2, "retried once, then recorded as done");
});

test("an expired subscription is dropped", async () => {
  const state = emptyState();
  const { okx } = fakeOkx(["gone"], () => ({ kind: "expired" }));
  const summary = await runRound(
    state,
    [signal(), signal({ id: "2" })],
    okx,
    opts(),
  );
  assert.deepEqual(summary.expiredJobs, ["gone"]);
  assert.equal(state.deliveries.gone, undefined);
});

test("at most maxSignalsPerRound new signals per round, strongest first", async () => {
  const state = emptyState();
  const signals = ["1", "2", "3", "4"].map((id) => signal({ id }));
  const summary = await runRound(
    state,
    signals,
    fakeOkx([]).okx,
    opts({ maxSignalsPerRound: 2 }),
  );
  assert.deepEqual(
    summary.newSignals.map((s) => s.id),
    ["1", "2"],
  );
  const next = await runRound(
    state,
    signals,
    fakeOkx([]).okx,
    opts({ maxSignalsPerRound: 2 }),
  );
  assert.deepEqual(
    next.newSignals.map((s) => s.id),
    ["3", "4"],
  );
});

test("a dry run sends nothing", async () => {
  const state = emptyState();
  const { okx, sent } = fakeOkx(["job-a"]);
  await runRound(state, [signal()], okx, opts({ dryRun: true }));
  assert.equal(sent.length, 0);
});
