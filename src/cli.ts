import { backtestCommand } from "./backtest.ts";
import { loadConfig, requireEnv, type Config } from "./config.ts";
import { createDatadash } from "./datadash.ts";
import { deliveryOutage, runRound, type RoundSummary } from "./dispatch.ts";
import { explainSignal, formatSignal } from "./format.ts";
import {
  loadHealth,
  recordPending,
  recordRound,
  saveHealth,
  sendAlert,
} from "./health.ts";
import { createOkx } from "./onchainos.ts";
import { fetchSignals } from "./signals.ts";
import { loadState, saveState, withStateLock } from "./state.ts";
import { writeTrackRecord } from "./trackRecord.ts";

const log = (line: string) =>
  console.log(`${new Date().toISOString()} ${line}`);

const USAGE = `Usage: node src/cli.ts <command>

  preview    Print the signals that qualify right now, with the reason each fired. Changes nothing.
  baseline   Mark every signal that qualifies now as already seen, so only positions opened from here on fire.
  round      Run one dispatch round: find new signals and deliver them to every active subscriber.
  run        Run rounds forever, every SCAN_INTERVAL_MIN minutes. This is the resident delivery program.
  track-record  Score every signal sent so far against the market, into reports/track-record.md.
  backtest   Replay the past BACKTEST_DAYS (default 180) of top-trader buys through the signal rules and write reports/backtest.md.`;

async function withSignals<T>(
  config: Config,
  fn: (signals: Awaited<ReturnType<typeof fetchSignals>>) => Promise<T>,
) {
  const datadash = createDatadash(config.datadashApiUrl, config.datadashApiKey);
  return fn(await fetchSignals(datadash, config.thresholds));
}

async function preview(config: Config) {
  await withSignals(config, async (signals) => {
    console.log(`${signals.length} signal(s) qualify now\n`);
    for (const signal of signals) {
      console.log(formatSignal(signal, config.signalValidHours));
      console.log(`  ${explainSignal(signal)}\n`);
    }
  });
}

async function baseline(config: Config) {
  await withStateLock(config.stateFile, async () => {
    const state = await loadState(config.stateFile);
    await withSignals(config, async (signals) => {
      const now = new Date().toISOString();
      for (const signal of signals) state.seen[signal.id] ??= now;
      await saveState(config.stateFile, state);
      log(`baseline: ${signals.length} current signal(s) marked as seen`);
    });
  });
}

/** One round. Returns its summary and one-line log; throws when the round could not run. */
async function round(
  config: Config,
): Promise<{ line: string; summary: RoundSummary }> {
  return withStateLock(config.stateFile, () => lockedRound(config));
}

async function lockedRound(
  config: Config,
): Promise<{ line: string; summary: RoundSummary }> {
  if (!config.dryRun) requireEnv(config, ["aspAgentId"]);
  const state = await loadState(config.stateFile);
  const summary = await withSignals(config, (signals) =>
    runRound(state, signals, createOkx(), {
      aspAgentId: config.aspAgentId,
      maxSignalsPerRound: config.maxSignalsPerRound,
      maxSignalsPerEvent: config.maxSignalsPerEvent,
      maxSignalsPerTrader: config.maxSignalsPerTrader,
      signalValidHours: config.signalValidHours,
      dryRun: config.dryRun,
      now: new Date(),
      log,
    }),
  );
  // A dry run only looks: it never marks signals as seen.
  if (!config.dryRun) await saveState(config.stateFile, state);
  const line =
    `round done: ${summary.newSignals.length} new, ${summary.activeJobs} active subscription(s), ` +
    `${summary.delivered} delivered, ${summary.failed} failed`;
  log(line);
  return { line, summary };
}

/**
 * After each round: record it in the health file, watch for subscriptions the provider's agent has not accepted,
 * and send any alert that calls for. Never throws: health checks must not stop delivery.
 */
async function afterRound(
  config: Config,
  result: { ok: true; summary: string } | { ok: false; error: string },
) {
  try {
    const now = new Date();
    const health = await loadHealth(config.healthFile);
    const alerts = recordRound(health, result, now, config.alertAfterFailures);
    if (!config.dryRun) {
      try {
        const pending = await createOkx().pendingSubscriptions();
        alerts.push(...recordPending(health, pending, now, config.pendingAlertMin));
      } catch (error) {
        log(`pending-subscription check failed: ${(error as Error).message}`);
      }
    }
    await saveHealth(config.healthFile, health);
    for (const alert of alerts)
      await sendAlert(config.alertWebhookUrl, alert, log);
  } catch (error) {
    log(`health update failed: ${(error as Error).message}`);
  }
}

async function run(config: Config) {
  requireEnv(config, ["aspAgentId"]);
  if (!config.dryRun) {
    const gate = await createOkx().gateCheck();
    if (!gate.ready) {
      // systemd restarts us every 30s; without this the only trace would be the journal.
      const message = `gate-check is not ready: ${JSON.stringify(gate.detail).slice(0, 300)}`;
      const health = await loadHealth(config.healthFile);
      const last = health.startAlertAt ? new Date(health.startAlertAt).getTime() : 0;
      if (Date.now() - last > 3_600_000) {
        health.startAlertAt = new Date().toISOString();
        await saveHealth(config.healthFile, health);
        await sendAlert(config.alertWebhookUrl, `Delivery can't start. ${message}`, log);
      }
      throw new Error(message);
    }
    log("gate-check ready");
  }

  let stopping = false;
  let wake: (() => void) | undefined;
  const stop = () => {
    stopping = true;
    wake?.();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (!stopping) {
    try {
      const { line, summary } = await round(config);
      const outage = deliveryOutage(summary);
      await afterRound(
        config,
        outage ? { ok: false, error: outage } : { ok: true, summary: line },
      );
    } catch (error) {
      // One bad round (network, API) must not stop the delivery program.
      const message = (error as Error).message;
      log(`round failed: ${message}`);
      await afterRound(config, { ok: false, error: message });
    }
    if (stopping) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, config.scanIntervalMin * 60_000);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
  log("stopped");
}

async function trackRecord(config: Config) {
  const state = await loadState(config.stateFile);
  const datadash = createDatadash(config.datadashApiUrl, config.datadashApiKey);
  const record = await writeTrackRecord(datadash, state.history, "reports");
  log(
    `track record: ${record.signals.length} signal(s) sent, ${record.resolved} settled, ${record.won} won` +
      (record.lookupsFailed ? `, ${record.lookupsFailed} lookup(s) failed (shown as unknown)` : "") +
      ". " +
      "Written to reports/track-record.md",
  );
}

const commands: Record<string, (config: Config) => Promise<unknown>> = {
  preview,
  baseline,
  round,
  run,
  "track-record": trackRecord,
  backtest: backtestCommand,
};
const command = commands[process.argv[2] ?? ""];
if (!command) {
  console.log(USAGE);
  process.exit(process.argv[2] ? 1 : 0);
}
command(loadConfig()).catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
