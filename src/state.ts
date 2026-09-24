import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Signal } from "./signals.ts";

/** A signal inside its validity window. Its text is rebuilt at each send with the time left (dispatch textAt). */
export type OutboxItem = { signal: Signal; createdAt: string };

/** Every signal ever sent, kept for the public track record. Never pruned. */
export type HistoryItem = {
  id: string;
  question: string;
  outcome: string;
  orderPrice: number;
  settlement: string | null;
  url: string;
  /** Polymarket's market slug and outcome token id, so an API caller can find the exact market. Absent on old entries. */
  marketSlug?: string;
  tokenId?: string;
  text: string;
  createdAt: string;
};

export type State = {
  version: 1;
  /** Signal id → when it was first seen. A signal fires once, the first time its position qualifies. */
  seen: Record<string, string>;
  /** Signals still inside their validity window. A subscriber who joins late still gets these. */
  outbox: OutboxItem[];
  /** Subscription jobId → signal ids it has already received. */
  deliveries: Record<string, string[]>;
  history: HistoryItem[];
};

export const emptyState = (): State => ({
  version: 1,
  seen: {},
  outbox: [],
  deliveries: {},
  history: [],
});

export async function loadState(path: string): Promise<State> {
  try {
    return {
      ...emptyState(),
      ...(JSON.parse(await readFile(path, "utf8")) as State),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw error;
  }
}

/** Written to a temp file and renamed, so a crash mid-write never leaves a half-written file. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // Per-process name: two writers must never share a temp file.
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tmp, path);
}

export const saveState = (path: string, state: State) =>
  writeJsonAtomic(path, state);

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** When a process started, from `ps` (Linux and macOS), or null when it can't be read. */
const startedAt = (pid: number): number | null => {
  try {
    const started = Date.parse(execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim());
    return Number.isNaN(started) ? null : started;
  } catch {
    return null;
  }
};

/**
 * Whether the process that wrote a lock is still the one holding it. Not when the id is gone, is our own (a lock
 * we left behind before a restart), or now belongs to a process that started after the lock was written: the id
 * was recycled, for example after a reboot.
 */
function holderAlive(pid: number, lockWrittenAt: number): boolean {
  if (!(pid > 0) || pid === process.pid || !isAlive(pid)) return false;
  const started = startedAt(pid);
  return started === null || started <= lockWrittenAt + 1000;
}

const lockedError = (pid: number) =>
  new Error(`state is locked by process ${pid}: another round is running`);

/**
 * Takes the lock. The process id is written to a private file first and linked into place in one step, so the
 * lock never exists empty and a contender always reads a real id. A stale lock is moved aside with rename, which
 * only one contender can win, and it is taken over only if what was moved is the lock that was judged stale;
 * a live lock grabbed in between is put back.
 */
async function acquireLock(lock: string): Promise<void> {
  const mine = `${lock}.${process.pid}.${randomUUID()}`;
  await writeFile(mine, String(process.pid));
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await link(mine, lock);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const holder = Number(await readFile(lock, "utf8").catch(() => ""));
      const writtenAt = (await stat(lock).catch(() => null))?.mtimeMs ?? 0;
      if (holderAlive(holder, writtenAt)) throw lockedError(holder);

      const aside = `${lock}.stale.${randomUUID()}`;
      try {
        await rename(lock, aside);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // released meanwhile: try again
        throw error;
      }
      const moved = Number(await readFile(aside, "utf8").catch(() => ""));
      if (moved !== holder) {
        // Someone took the lock between our read and our rename: give it back and stand down.
        await link(aside, lock).catch(() => {});
        await rm(aside, { force: true });
        throw lockedError(moved);
      }
      await rm(aside, { force: true });
    }
    throw new Error("could not take the state lock");
  } finally {
    await rm(mine, { force: true });
  }
}

/** Removes the lock only while it is still ours. */
async function releaseLock(lock: string): Promise<void> {
  const holder = Number(await readFile(lock, "utf8").catch(() => ""));
  if (holder === process.pid) await rm(lock, { force: true });
}

/**
 * Runs `fn` holding an exclusive lock beside the state file, so the resident program and a manual `pnpm round`
 * or `pnpm baseline` never both read, change and write state; the loser's updates would be lost and a signal
 * re-sent. A lock whose process is gone, is this process, or was recycled is taken over.
 */
export async function withStateLock<T>(
  path: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lock = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true });
  await acquireLock(lock);
  try {
    return await fn();
  } finally {
    await releaseLock(lock);
  }
}
