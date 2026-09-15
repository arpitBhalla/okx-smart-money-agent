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
  maxDaysLeft: number;
};

export type Config = {
  datadashApiKey: string;
  datadashMcpUrl: string;
  aspAgentId: string;
  stateFile: string;
  scanIntervalMin: number;
  maxSignalsPerRound: number;
  signalValidHours: number;
  dryRun: boolean;
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
    scanIntervalMin: num("SCAN_INTERVAL_MIN", 10),
    maxSignalsPerRound: num("MAX_SIGNALS_PER_ROUND", 3),
    signalValidHours: num("SIGNAL_VALID_HOURS", 2),
    dryRun: process.env.DRY_RUN === "1",
    thresholds: {
      maxTraderRank: num("MAX_TRADER_RANK", 500),
      minScore: num("MIN_SCORE", 80),
      minRelSize: num("MIN_REL_SIZE", 3),
      minTradeUsd: num("MIN_TRADE_USD", 5000),
      minPrice: num("MIN_PRICE", 0.1),
      maxPrice: num("MAX_PRICE", 0.9),
      maxChase: num("MAX_CHASE", 0.03),
      maxDaysLeft: num("MAX_DAYS_LEFT", 120),
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
