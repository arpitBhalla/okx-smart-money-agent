import assert from "node:assert/strict";
import { test } from "node:test";
import { createDatadash, readToken } from "../src/datadash.ts";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fetch that answers from a script, one step per call, and records what it was asked. */
function scripted(steps: (() => Response)[]) {
  const calls: Request[] = [];
  const fetchImpl = (async (input: Request) => {
    calls.push(input);
    const step = steps[calls.length - 1];
    if (!step) throw new Error("unexpected extra call");
    return step();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const fast = { backoffMs: [0, 0] };
const body = { page: { limit: 1 } };

test("posts JSON to the endpoint and returns the rows", async () => {
  const { fetchImpl, calls } = scripted([() => json(200, [{ score: 90 }])]);
  const rows = await createDatadash("https://api.example/", "", fetchImpl, fast).list("/api/v1/signals/scores", body);
  assert.deepEqual(rows, [{ score: 90 }]);
  assert.equal(calls[0].url, "https://api.example/api/v1/signals/scores");
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(await calls[0].json(), body);
  assert.equal(calls[0].headers.get("x-api-key"), null, "no key configured: no header");
});

test("sends the API key when there is one", async () => {
  const { fetchImpl, calls } = scripted([() => json(200, [])]);
  await createDatadash("https://api.example", "k-123", fetchImpl, fast).list("/api/v1/activity", body);
  assert.equal(calls[0].headers.get("x-api-key"), "k-123");
});

test("a 5xx or 429 is retried; a 400 is not", async () => {
  const flaky = scripted([() => json(503, { message: "busy" }), () => json(429, {}), () => json(200, [{ ok: 1 }])]);
  assert.deepEqual(
    await createDatadash("https://api.example", "", flaky.fetchImpl, fast).list("/api/v1/activity", body),
    [{ ok: 1 }],
  );
  assert.equal(flaky.calls.length, 3);

  const bad = scripted([() => json(400, { message: 'unknown field "nope"' })]);
  await assert.rejects(
    createDatadash("https://api.example", "", bad.fetchImpl, fast).list("/api/v1/activity", body),
    /returned 400: .*unknown field/,
  );
  assert.equal(bad.calls.length, 1, "a bad request never retries");
});

test("a network failure is retried, then reported with its cause", async () => {
  const down = scripted(
    Array.from({ length: 3 }, () => () => {
      throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND api.example") });
    }),
  );
  await assert.rejects(
    createDatadash("https://api.example", "", down.fetchImpl, fast).list("/api/v1/activity", body),
    /\/api\/v1\/activity request failed: fetch failed \(getaddrinfo ENOTFOUND api\.example\)/,
  );
  assert.equal(down.calls.length, 3, "first try plus two retries");
});

test("an answer that is not a list is an error", async () => {
  const { fetchImpl } = scripted([() => json(200, { rows: [] })]);
  await assert.rejects(
    createDatadash("https://api.example", "", fetchImpl, fast).list("/api/v1/activity", body),
    /did not return a list/,
  );
});

test("readToken settles optional fields and rejects a token without a position", () => {
  assert.equal(readToken(undefined), null);
  assert.equal(readToken({ tokenName: "Yes" }), null);
  assert.deepEqual(readToken({ positionId: 7, tokenName: "No", tagIds: [2] }), {
    positionId: 7,
    marketId: null,
    eventId: null,
    marketQuestion: "",
    marketSlug: "",
    eventSlug: "",
    tokenName: "No",
    tokenId: "",
    tokenPrice: NaN,
    marketClosed: false,
    marketClosedTime: null,
    marketEndDate: null,
    tagIds: [2],
  });
});
