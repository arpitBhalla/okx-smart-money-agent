import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyHealth, recordPending, recordRound } from "../src/health.ts";

const at = (minute: number) => new Date(Date.UTC(2026, 8, 23, 12, minute));

test("failures alert once when they reach the threshold, and again on recovery", () => {
  const health = emptyHealth();
  const fail = { ok: false as const, error: "Datadash timeout" };
  assert.deepEqual(recordRound(health, fail, at(0), 3), []);
  assert.deepEqual(recordRound(health, fail, at(2), 3), []);
  const [alert] = recordRound(health, fail, at(4), 3);
  assert.match(alert, /failed 3 rounds in a row\. Last error: Datadash timeout/);
  assert.deepEqual(recordRound(health, fail, at(6), 3), [], "no repeat");
  const [recovered] = recordRound(health, { ok: true, summary: "ok" }, at(8), 3);
  assert.match(recovered, /recovered/);
  assert.equal(health.consecutiveFailures, 0);
  assert.equal(health.lastSuccessAt, at(8).toISOString());
});

test("a single failed round stays quiet", () => {
  const health = emptyHealth();
  recordRound(health, { ok: false, error: "blip" }, at(0), 3);
  assert.deepEqual(recordRound(health, { ok: true, summary: "ok" }, at(2), 3), []);
});

test("a subscription waiting past the limit alerts once; accepted ones are forgotten", () => {
  const health = emptyHealth();
  assert.deepEqual(recordPending(health, ["j1"], at(0), 15), []);
  assert.deepEqual(recordPending(health, ["j1", "j2"], at(10), 15), []);
  const alerts = recordPending(health, ["j1", "j2"], at(16), 15);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /j1 has waited 16 minutes/);
  assert.deepEqual(recordPending(health, ["j1", "j2"], at(20), 15), [], "j1 already alerted, j2 at 10 min");
  recordPending(health, ["j2"], at(22), 15);
  assert.deepEqual(Object.keys(health.pendingSince), ["j2"]);
  assert.deepEqual(health.alertedPending, []);
});
