export type Thresholds = {
  /** Only wallets ranked this high or better on the all-time PnL leaderboard. */
  maxTraderRank: number;
  /** Datadash Signal Score, 0-100. */
  minScore: number;
  /** Bet size against the wallet's usual size (3 = three times bigger than usual). */
  minRelSize: number;
  /** The wallet's peak USD cost on the position. */
  minTradeUsd: number;
  /** Live price band of the signalled outcome. Outside it the upside or the odds are too thin to copy. */
  minPrice: number;
  maxPrice: number;
  /** How far above the trader's own entry the price may be before the signal is stale. */
  maxChase: number;
  /** How far below the trader's entry the price may have fallen. Further down, the market is moving against them. */
  maxDrop: number;
  maxDaysLeft: number;
  /** A top trader must have traded the position this recently, so the signal is news rather than an old holding. */
  maxPositionAgeDays: number;
  /**
   * Smart-money consensus: of the money top-ranked wallets hold on the market, at least this share must be on the
   * signal's side, held by at least this many wallets. A lone whale is not enough.
   */
  minConsensusShare: number;
  minConsensusWallets: number;
};

export type Config = {
  datadashApiKey: string;
  datadashMcpUrl: string;
  aspAgentId: string;
  stateFile: string;
  scanIntervalMin: number;
  maxSignalsPerRound: number;
  /** Signals a single event or a single top trader may have live at once, so subscribers never copy one bet many times. */
  maxSignalsPerEvent: number;
  maxSignalsPerTrader: number;
  signalValidHours: number;
  dryRun: boolean;
  healthFile: string;
  /** Slack- or Discord-compatible incoming webhook. Empty means alerts only go to the log. */
  alertWebhookUrl: string;
  alertAfterFailures: number;
  /** A subscription waiting this long for the provider's agent to accept it means that agent session is down. */
  pendingAlertMin: number;
  thresholds: Thresholds;
};

const num = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value))
    throw new Error(`${name} must be a number, got "${raw}"`);
  return value;
};

export function loadConfig(): Config {
  return {
    datadashApiKey: process.env.DATADASH_API_KEY ?? "",
    datadashMcpUrl:
      process.env.DATADASH_MCP_URL || "https://api.datadash.xyz/mcp",
    aspAgentId: process.env.OKX_ASP_AGENT_ID ?? "",
    stateFile: process.env.STATE_FILE || "./data/state.json",
    scanIntervalMin: num("SCAN_INTERVAL_MIN", 2),
    maxSignalsPerRound: num("MAX_SIGNALS_PER_ROUND", 3),
    maxSignalsPerEvent: num("MAX_SIGNALS_PER_EVENT", 1),
    maxSignalsPerTrader: num("MAX_SIGNALS_PER_TRADER", 1),
    signalValidHours: num("SIGNAL_VALID_HOURS", 2),
    dryRun: process.env.DRY_RUN === "1",
    healthFile: process.env.HEALTH_FILE || "./data/health.json",
    alertWebhookUrl: process.env.ALERT_WEBHOOK_URL ?? "",
    alertAfterFailures: num("ALERT_AFTER_FAILURES", 3),
    pendingAlertMin: num("PENDING_ALERT_MIN", 15),
    thresholds: {
      maxTraderRank: num("MAX_TRADER_RANK", 500),
      minScore: num("MIN_SCORE", 80),
      minRelSize: num("MIN_REL_SIZE", 3),
      minTradeUsd: num("MIN_TRADE_USD", 5000),
      minPrice: num("MIN_PRICE", 0.1),
      maxPrice: num("MAX_PRICE", 0.85),
      maxChase: num("MAX_CHASE", 0.03),
      maxDrop: num("MAX_DROP", 0.1),
      maxDaysLeft: num("MAX_DAYS_LEFT", 120),
      maxPositionAgeDays: num("MAX_POSITION_AGE_DAYS", 7),
      minConsensusShare: num("MIN_CONSENSUS_SHARE", 0.6),
      minConsensusWallets: num("MIN_CONSENSUS_WALLETS", 3),
    },
  };
}

export function requireEnv(
  config: Config,
  keys: ("datadashApiKey" | "aspAgentId")[],
): void {
  const names = {
    datadashApiKey: "DATADASH_API_KEY",
    aspAgentId: "OKX_ASP_AGENT_ID",
  } as const;
  const missing = keys.filter((key) => !config[key]).map((key) => names[key]);
  if (missing.length)
    throw new Error(
      `Missing ${missing.join(", ")}. Copy .env.example to .env and fill it in.`,
    );
}
