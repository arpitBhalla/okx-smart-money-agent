import assert from "node:assert/strict";
import { test } from "node:test";
import { createOkx, parseCliJson, type Runner } from "../src/onchainos.ts";

const replying =
  (stdout: string, code = 0): Runner =>
  async () => ({ stdout, stderr: "", code });

test("parses JSON printed after log lines", () => {
  assert.deepEqual(parseCliJson('checking...\n{"ok":true,"data":[]}\n'), {
    ok: true,
    data: [],
  });
});

test("subscribe-active reads jobIds from data or data.list", async () => {
  const flat = createOkx(
    replying('{"ok":true,"data":[{"jobId":"a"},{"jobId":"b"}]}'),
  );
  assert.deepEqual(await flat.activeSubscriptions("42"), ["a", "b"]);
  const wrapped = createOkx(
    replying('{"ok":true,"data":{"list":[{"jobId":"c"}]}}'),
  );
  assert.deepEqual(await wrapped.activeSubscriptions("42"), ["c"]);
});

test("deliver maps the four-state contract", async () => {
  const deliver = (stdout: string) =>
    createOkx(replying(stdout)).deliver("job", "42", "signal");
  assert.deepEqual(
    await deliver(
      '{"ok":true,"delivered":true,"jobId":"job","deliveryId":"d1"}',
    ),
    {
      kind: "delivered",
      deliveryId: "d1",
    },
  );
  assert.deepEqual(
    await deliver('{"ok":true,"delivered":false,"reason":"alreadyDelivered"}'),
    {
      kind: "alreadyDelivered",
    },
  );
  assert.deepEqual(
    await deliver(
      '{"ok":false,"reason":"subscriptionExpired","backendCode":"7"}',
    ),
    { kind: "expired" },
  );
  assert.deepEqual(
    await deliver('{"ok":false,"reason":"sendFailed","message":"xmtp down"}'),
    {
      kind: "failed",
      message: "xmtp down",
    },
  );
  assert.equal((await deliver("segfault")).kind, "failed");
});

test("deliver passes the signal text as one argument", async () => {
  let args: string[] = [];
  const okx = createOkx(async (a) => {
    args = a;
    return { stdout: '{"ok":true,"delivered":true}', stderr: "", code: 0 };
  });
  await okx.deliver("job-1", "42", '【Prediction】"Q?" | NO');
  assert.deepEqual(args, [
    "agent",
    "deliver",
    "job-1",
    "--agent-id",
    "42",
    "--deliverable-text",
    '【Prediction】"Q?" | NO',
  ]);
});

test("gate-check is ready only when data.ready is true", async () => {
  assert.equal(
    (await createOkx(replying('{"ok":true,"data":{"ready":true}}')).gateCheck())
      .ready,
    true,
  );
  assert.equal(
    (
      await createOkx(
        replying('{"ok":true,"data":{"ready":false}}'),
      ).gateCheck()
    ).ready,
    false,
  );
});

test("pending subscriptions are read-only and accept list or data.list", async () => {
  let args: string[] = [];
  const okx = createOkx(async (a) => {
    args = a;
    return { stdout: '{"list":[{"jobId":"j1"},{"jobId":"j2"}]}', stderr: "", code: 0 };
  });
  assert.deepEqual(await okx.pendingSubscriptions(), ["j1", "j2"]);
  assert.deepEqual(args, ["agent", "my-subscriptions", "--role", "provider", "--status", "CREATED"]);
  assert.deepEqual(
    await createOkx(replying('{"ok":true,"data":{"list":[{"jobId":"j3"}]}}')).pendingSubscriptions(),
    ["j3"],
  );
});
