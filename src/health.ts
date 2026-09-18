import { readFile } from "node:fs/promises";
import { writeJsonAtomic } from "./state.ts";

/** What the resident program last did, for `systemctl`-free checks and for alerting. Kept in data/health.json. */
export type Health = {
  lastRoundAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  lastSummary: string | null;
  /** Subscription jobId → when this program first saw it waiting for the provider's acceptance. */
  pendingSince: Record<string, string>;
  /** Pending jobs already alerted on, so one stuck subscription alerts once. */
  alertedPending: string[];
};

export const emptyHealth = (): Health => ({
  lastRoundAt: null,
  lastSuccessAt: null,
  lastError: null,
  consecutiveFailures: 0,
  lastSummary: null,
  pendingSince: {},
  alertedPending: [],
});

export async function loadHealth(path: string): Promise<Health> {
  try {
    return { ...emptyHealth(), ...(JSON.parse(await readFile(path, "utf8")) as Health) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyHealth();
    throw error;
  }
}

export const saveHealth = (path: string, health: Health) =>
  writeJsonAtomic(path, health);

/**
 * Records one round and returns the alerts it calls for: one when failures reach `alertAfter` in a row, and
 * one when delivery recovers after that. A single failed round is normal (a network blip) and stays quiet.
 */
export function recordRound(
  health: Health,
  result: { ok: true; summary: string } | { ok: false; error: string },
  now: Date,
  alertAfter: number,
): string[] {
  const at = now.toISOString();
  health.lastRoundAt = at;
  if (result.ok) {
    const recovered = health.consecutiveFailures >= alertAfter;
    health.consecutiveFailures = 0;
    health.lastSuccessAt = at;
    health.lastSummary = result.summary;
    return recovered ? ["Signal delivery recovered: the last round succeeded."] : [];
  }
  health.consecutiveFailures += 1;
  health.lastError = result.error;
  return health.consecutiveFailures === alertAfter
    ? [
        `Signal delivery has failed ${alertAfter} rounds in a row. Last error: ${result.error}`,
      ]
    : [];
}

/**
 * Tracks subscriptions waiting for acceptance and returns an alert for each one waiting longer than
 * `alertAfterMin`. Only the provider's own agent session may accept, so a long wait means that session is down.
 */
export function recordPending(
  health: Health,
  pendingJobIds: string[],
  now: Date,
  alertAfterMin: number,
): string[] {
  const waiting = new Set(pendingJobIds);
  const since: Record<string, string> = {};
  for (const jobId of waiting)
    since[jobId] = health.pendingSince[jobId] ?? now.toISOString();
  health.pendingSince = since;
  health.alertedPending = health.alertedPending.filter((jobId) => waiting.has(jobId));

  const alerts: string[] = [];
  for (const [jobId, firstSeen] of Object.entries(since)) {
    const minutes = (now.getTime() - new Date(firstSeen).getTime()) / 60_000;
    if (minutes < alertAfterMin || health.alertedPending.includes(jobId)) continue;
    health.alertedPending.push(jobId);
    alerts.push(
      `Subscription ${jobId} has waited ${Math.round(minutes)} minutes for acceptance. Check that the provider's agent session (Claude Code with the okx-ai skill) is running.`,
    );
  }
  return alerts;
}

/** Posts to a Slack- or Discord-style incoming webhook. An alert that fails to send is logged, never thrown. */
export async function sendAlert(
  url: string,
  text: string,
  log: (line: string) => void,
): Promise<void> {
  log(`ALERT: ${text}`);
  if (!url) return;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `Datadash Smart Money: ${text}`, content: `Datadash Smart Money: ${text}` }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) log(`alert webhook answered ${response.status}`);
  } catch (error) {
    log(`alert webhook failed: ${(error as Error).message}`);
  }
}
