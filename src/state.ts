import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Signal } from "./signals.ts";

export type OutboxItem = { signal: Signal; text: string; createdAt: string };

/** Every signal ever sent, kept for the public track record. Never pruned. */
export type HistoryItem = {
  id: string;
  question: string;
  outcome: string;
  orderPrice: number;
  settlement: string | null;
  url: string;
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
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tmp, path);
}

export const saveState = (path: string, state: State) =>
  writeJsonAtomic(path, state);
