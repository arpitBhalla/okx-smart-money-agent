import assert from "node:assert/strict";
import { test } from "node:test";
import { deliveryOutage, runRound, type RoundOptions } from "../src/dispatch.ts";
import type { DeliverResult, Okx } from "../src/onchainos.ts";
import { emptyState } from "../src/state.ts";
import { signal } from "./fixtures.ts";

const opts = (over: Partial<RoundOptions> = {}): RoundOptions => ({
  aspAgentId: "42",
  maxSignalsPerRound: 3,
  // The caps have their own tests; elsewhere the fixtures share one event and one trader.
  maxSignalsPerEvent: 99,
  maxSignalsPerTrader: 99,
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
    pendingSubscriptions: async () => [],
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

const trader = (wallet: string) => ({ ...signal().traders[0], wallet });

test("one live signal per event: a second signal on the same event waits for a later round", async () => {
  const state = emptyState();
  const capped = opts({ maxSignalsPerEvent: 1, maxSignalsPerTrader: 1 });
  const first = signal({ id: "1", eventId: 100, traders: [trader("0xa")] });
  const sameEvent = signal({ id: "2", eventId: 100, traders: [trader("0xb")] });
  const other = signal({ id: "3", eventId: 200, traders: [trader("0xc")] });

  const round1 = await runRound(state, [first, sameEvent, other], fakeOkx([]).okx, capped);
  assert.deepEqual(round1.newSignals.map((s) => s.id), ["1", "3"]);
  assert.equal(state.seen["2"], undefined, "held back, not marked seen");

  // Once the first signal's validity window has passed, the held-back one goes out.
  const later = opts({ ...capped, now: new Date("2026-09-22T14:30:00Z") });
  const round2 = await runRound(state, [first, sameEvent, other], fakeOkx([]).okx, later);
  assert.deepEqual(round2.newSignals.map((s) => s.id), ["2"]);
});

test("one live signal per top trader, counting every trader in a signal", async () => {
  const state = emptyState();
  const capped = opts({ maxSignalsPerEvent: 9, maxSignalsPerTrader: 1 });
  const round = await runRound(
    state,
    [
      signal({ id: "1", eventId: 1, traders: [trader("0xa"), trader("0xb")] }),
      signal({ id: "2", eventId: 2, traders: [trader("0xb")] }),
      signal({ id: "3", eventId: 3, traders: [trader("0xc")] }),
    ],
    fakeOkx([]).okx,
    capped,
  );
  assert.deepEqual(round.newSignals.map((s) => s.id), ["1", "3"]);
});

test("every admitted signal is kept in the history for the track record", async () => {
  const state = emptyState();
  await runRound(state, [signal()], fakeOkx([]).okx, opts());
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].orderPrice, 0.43);
  assert.match(state.history[0].url, /^https:\/\/polymarket\.com\/event\//);
});

test("a round where every send failed is an outage even though it ran", () => {
  const summary = { newSignals: [], activeJobs: 2, delivered: 0, failed: 3, expiredJobs: [] };
  assert.match(deliveryOutage(summary) ?? "", /all 3 send\(s\) to 2 subscription\(s\) failed/);
  assert.equal(deliveryOutage({ ...summary, delivered: 1 }), null, "some got through");
  assert.equal(deliveryOutage({ ...summary, failed: 0 }), null, "nothing to send");
  assert.equal(deliveryOutage({ ...summary, activeJobs: 0 }), null, "no subscribers");
});

test("state saved before history and eventId existed still loads and admits", async () => {
  const state = { ...emptyState(), history: undefined } as unknown as ReturnType<typeof emptyState>;
  const old = signal({ id: "9" }) as Partial<ReturnType<typeof signal>>;
  delete old.eventId;
  state.outbox = [{ signal: old as ReturnType<typeof signal>, text: "old", createdAt: "2026-09-22T11:30:00.000Z" }];
  const migrated = { ...emptyState(), ...state, history: state.history ?? [] };
  const round = await runRound(migrated, [signal({ id: "1", traders: [{ ...signal().traders[0], wallet: "0xnew" }] })], fakeOkx([]).okx,
    opts({ maxSignalsPerEvent: 1, maxSignalsPerTrader: 1 }));
  assert.deepEqual(round.newSignals.map((s) => s.id), ["1"], "the old item doesn't count toward the event cap");
  assert.equal(migrated.history.length, 1);
});
