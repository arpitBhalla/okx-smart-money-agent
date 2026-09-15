import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Signal } from "./signals.ts";

export type OutboxItem = { signal: Signal; text: string; createdAt: string };

export type State = {
  version: 1;
  /** Signal id → when it was first seen. A signal fires once, the first time its position qualifies. */
  seen: Record<string, string>;
  /** Signals still inside their validity window. A subscriber who joins late still gets these. */
  outbox: OutboxItem[];
  /** Subscription jobId → signal ids it has already received. */
  deliveries: Record<string, string[]>;
};

export const emptyState = (): State => ({
  version: 1,
  seen: {},
  outbox: [],
  deliveries: {},
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

/** Written to a temp file and renamed, so a crash mid-write never leaves a half-written state. */
export async function saveState(path: string, state: State): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
  await rename(tmp, path);
}
