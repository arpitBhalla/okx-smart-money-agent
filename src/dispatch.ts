import { formatSignal } from "./format.ts";
import type { Okx } from "./onchainos.ts";
import type { Signal } from "./signals.ts";
import type { State } from "./state.ts";

export type RoundOptions = {
  aspAgentId: string;
  maxSignalsPerRound: number;
  signalValidHours: number;
  dryRun: boolean;
  now: Date;
  log: (line: string) => void;
};

export type RoundSummary = {
  newSignals: Signal[];
  activeJobs: number;
  delivered: number;
  failed: number;
  expiredJobs: string[];
};

/**
 * Records the signals that qualify for the first time and drops outbox items past their validity window. At
 * most `maxSignalsPerRound` new signals per round, strongest first, so subscribers are never flooded.
 */
export function admitSignals(
  state: State,
  signals: Signal[],
  opts: RoundOptions,
): Signal[] {
  const cutoff = opts.now.getTime() - opts.signalValidHours * 3_600_000;
  state.outbox = state.outbox.filter(
    (item) => new Date(item.createdAt).getTime() > cutoff,
  );

  const fresh = signals
    .filter((signal) => !state.seen[signal.id])
    .slice(0, opts.maxSignalsPerRound);
  const createdAt = opts.now.toISOString();
  for (const signal of fresh) {
    state.seen[signal.id] = createdAt;
    state.outbox.push({
      signal,
      text: formatSignal(signal, opts.signalValidHours),
      createdAt,
    });
  }
  return fresh;
}

/** One dispatch round: admit new signals, then send every outbox item each active subscription has not had yet. */
export async function runRound(
  state: State,
  signals: Signal[],
  okx: Okx,
  opts: RoundOptions,
): Promise<RoundSummary> {
  const newSignals = admitSignals(state, signals, opts);
  for (const signal of newSignals)
    opts.log(
      `new signal ${signal.id}: ${formatSignal(signal, opts.signalValidHours)}`,
    );

  const summary: RoundSummary = {
    newSignals,
    activeJobs: 0,
    delivered: 0,
    failed: 0,
    expiredJobs: [],
  };
  if (opts.dryRun) {
    opts.log(
      `dry run: ${state.outbox.length} signal(s) in the outbox, nothing sent`,
    );
    return summary;
  }

  const jobs = await okx.activeSubscriptions(opts.aspAgentId);
  summary.activeJobs = jobs.length;

  for (const jobId of jobs) {
    const done = new Set(state.deliveries[jobId] ?? []);
    for (const item of state.outbox) {
      if (done.has(item.signal.id)) continue;
      const result = await okx.deliver(jobId, opts.aspAgentId, item.text);
      if (result.kind === "delivered" || result.kind === "alreadyDelivered") {
        done.add(item.signal.id);
        if (result.kind === "delivered") summary.delivered += 1;
        opts.log(`job ${jobId}: ${result.kind} signal ${item.signal.id}`);
      } else if (result.kind === "expired") {
        summary.expiredJobs.push(jobId);
        opts.log(`job ${jobId}: subscription ended, skipping it`);
        break;
      } else {
        // Left undelivered, so the next round retries the same signal.
        summary.failed += 1;
        opts.log(
          `job ${jobId}: send failed for signal ${item.signal.id}: ${result.message}`,
        );
      }
    }
    state.deliveries[jobId] = [...done];
  }
  for (const jobId of summary.expiredJobs) delete state.deliveries[jobId];
  return summary;
}
