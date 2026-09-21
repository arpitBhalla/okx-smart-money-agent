import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withStateLock } from "../src/state.ts";

const tempState = async () => join(await mkdtemp(join(tmpdir(), "state-lock-")), "state.json");
const exists = (path: string) => stat(path).then(() => true, () => false);

/** A separate process that sleeps until killed; its pid stands in for another running round. */
function sleeper() {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
  return { pid: child.pid!, stop: () => new Promise((done) => { child.once("exit", done); child.kill(); }) };
}

test("a lock held by another live process blocks the round", async () => {
  const path = await tempState();
  // pid 1 (init / launchd) is alive and started long before this lock was written.
  await writeFile(`${path}.lock`, "1");
  await assert.rejects(withStateLock(path, async () => "ran"), /locked by process 1/);
  assert.equal(await readFile(`${path}.lock`, "utf8"), "1", "the live lock is left in place");
});

test("a lock whose process has exited is taken over and released afterwards", async () => {
  const path = await tempState();
  const other = sleeper();
  await other.stop();
  await writeFile(`${path}.lock`, String(other.pid));
  assert.equal(await withStateLock(path, async () => readFile(`${path}.lock`, "utf8")), String(process.pid));
  assert.equal(await exists(`${path}.lock`), false);
});

test("a lock with our own pid, left before a restart, is taken over", async () => {
  const path = await tempState();
  await writeFile(`${path}.lock`, String(process.pid));
  assert.equal(await withStateLock(path, async () => "ran"), "ran");
});

test("a lock whose pid was recycled by a newer process is taken over", async () => {
  const path = await tempState();
  const other = sleeper();
  try {
    await writeFile(`${path}.lock`, String(other.pid));
    // Written long before that process started: the id was reused, the real holder is gone.
    await utimes(`${path}.lock`, new Date("2020-01-01"), new Date("2020-01-01"));
    assert.equal(await withStateLock(path, async () => "ran"), "ran");
  } finally {
    await other.stop();
  }
});

test("an empty or unreadable lock never counts as live", async () => {
  const path = await tempState();
  await writeFile(`${path}.lock`, "");
  assert.equal(await withStateLock(path, async () => "ran"), "ran");
});

test("the lock is never empty while held, and a failing round still releases it", async () => {
  const path = await tempState();
  await assert.rejects(
    withStateLock(path, async () => {
      assert.equal(await readFile(`${path}.lock`, "utf8"), String(process.pid));
      throw new Error("round failed");
    }),
    /round failed/,
  );
  assert.equal(await exists(`${path}.lock`), false);
});

test("two processes racing for the lock: exactly one runs", async () => {
  const path = await tempState();
  const script = `
    import { withStateLock } from ${JSON.stringify(new URL("../src/state.ts", import.meta.url).href)};
    withStateLock(${JSON.stringify(path)}, () => new Promise((done) => setTimeout(done, 500)))
      .then(() => console.log("ran"), (error) => console.log(error.message));
  `;
  const run = () =>
    new Promise<string>((resolve) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script]);
      let out = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.on("exit", () => resolve(out.trim()));
    });
  const results = await Promise.all([run(), run(), run()]);
  assert.equal(results.filter((r) => r === "ran").length, 1, results.join(" | "));
  assert.equal(results.filter((r) => /locked by process/.test(r)).length, 2, results.join(" | "));
});
