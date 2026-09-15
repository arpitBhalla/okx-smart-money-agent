import { loadConfig, requireEnv, type Config } from "./config.ts";
import { connectDatadash } from "./datadash.ts";
import { runRound } from "./dispatch.ts";
import { explainSignal, formatSignal } from "./format.ts";
import { createOkx } from "./onchainos.ts";
import { fetchSignals } from "./signals.ts";
import { loadState, saveState } from "./state.ts";

const log = (line: string) =>
  console.log(`${new Date().toISOString()} ${line}`);

const USAGE = `Usage: node src/cli.ts <command>

  preview    Print the signals that qualify right now, with the reason each fired. Changes nothing.
  baseline   Mark every signal that qualifies now as already seen, so only positions opened from here on fire.
  round      Run one dispatch round: find new signals and deliver them to every active subscriber.
  run        Run rounds forever, every SCAN_INTERVAL_MIN minutes. This is the resident delivery program.`;

async function withSignals<T>(
  config: Config,
  fn: (signals: Awaited<ReturnType<typeof fetchSignals>>) => Promise<T>,
) {
  const datadash = await connectDatadash(
    config.datadashMcpUrl,
    config.datadashApiKey,
  );
  try {
    return await fn(await fetchSignals(datadash, config.thresholds));
  } finally {
    await datadash.close();
  }
}

async function preview(config: Config) {
  requireEnv(config, ["datadashApiKey"]);
  await withSignals(config, async (signals) => {
    console.log(`${signals.length} signal(s) qualify now\n`);
    for (const signal of signals) {
      console.log(formatSignal(signal, config.signalValidHours));
      console.log(`  ${explainSignal(signal)}\n`);
    }
  });
}

async function baseline(config: Config) {
  requireEnv(config, ["datadashApiKey"]);
  const state = await loadState(config.stateFile);
  await withSignals(config, async (signals) => {
    const now = new Date().toISOString();
    for (const signal of signals) state.seen[signal.id] ??= now;
    await saveState(config.stateFile, state);
    log(`baseline: ${signals.length} current signal(s) marked as seen`);
  });
}

async function round(config: Config) {
  requireEnv(
    config,
    config.dryRun ? ["datadashApiKey"] : ["datadashApiKey", "aspAgentId"],
  );
  const state = await loadState(config.stateFile);
  const summary = await withSignals(config, (signals) =>
    runRound(state, signals, createOkx(), {
      aspAgentId: config.aspAgentId,
      maxSignalsPerRound: config.maxSignalsPerRound,
      signalValidHours: config.signalValidHours,
      dryRun: config.dryRun,
      now: new Date(),
      log,
    }),
  );
  // A dry run only looks: it never marks signals as seen.
  if (!config.dryRun) await saveState(config.stateFile, state);
  log(
    `round done: ${summary.newSignals.length} new, ${summary.activeJobs} active subscription(s), ` +
      `${summary.delivered} delivered, ${summary.failed} failed`,
  );
}

async function run(config: Config) {
  requireEnv(config, ["datadashApiKey", "aspAgentId"]);
  if (!config.dryRun) {
    const gate = await createOkx().gateCheck();
    if (!gate.ready)
      throw new Error(
        `gate-check is not ready: ${JSON.stringify(gate.detail)}`,
      );
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
      await round(config);
    } catch (error) {
      // One bad round (network, API) must not stop the delivery program.
      log(`round failed: ${(error as Error).message}`);
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

const commands: Record<string, (config: Config) => Promise<void>> = {
  preview,
  baseline,
  round,
  run,
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
