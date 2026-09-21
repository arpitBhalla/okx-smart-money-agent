import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Datadash } from "./datadash.ts";
import { pool } from "./pool.ts";
import type { HistoryItem } from "./state.ts";

/** The part of the outcome-token lookup the track record needs. */
export type TokenOutcome = {
  positionId: number;
  tokenPrice: number;
  marketClosed: boolean;
};

export type TrackedSignal = HistoryItem & {
  status: "won" | "lost" | "open" | "unknown";
  /** Price now, or the settled payout (1 or 0). Null when Datadash no longer knows the token. */
  priceNow: number | null;
  /** Per dollar at the order price: settled for won/lost, marked to market for open. */
  return: number | null;
};

export type TrackRecord = {
  signals: TrackedSignal[];
  resolved: number;
  won: number;
  /** Average settled return per signal, or null before any signal settles. */
  avgReturn: number | null;
  /** Settled profit if a copier had put $100 on every resolved signal. */
  pnlPer100: number;
  /** Outcome lookups that failed this run; those signals show as unknown until the next run. */
  lookupsFailed?: number;
};

/**
 * Scores every signal ever sent. A closed market's winning token trades at 1 and the losing one at 0, so a
 * closed token priced in between is still settling and counts as open.
 */
export function scoreHistory(
  history: HistoryItem[],
  tokens: Map<number, TokenOutcome>,
): TrackRecord {
  const signals = history.map((item): TrackedSignal => {
    const token = tokens.get(Number(item.id));
    if (!token) return { ...item, status: "unknown", priceNow: null, return: null };
    const settled =
      token.marketClosed && (token.tokenPrice >= 0.99 || token.tokenPrice <= 0.01);
    const priceNow = settled ? Math.round(token.tokenPrice) : token.tokenPrice;
    return {
      ...item,
      status: settled ? (priceNow === 1 ? "won" : "lost") : "open",
      priceNow,
      return: priceNow / item.orderPrice - 1,
    };
  });

  const resolved = signals.filter((s) => s.status === "won" || s.status === "lost");
  const total = resolved.reduce((sum, s) => sum + (s.return ?? 0), 0);
  return {
    signals,
    resolved: resolved.length,
    won: resolved.filter((s) => s.status === "won").length,
    avgReturn: resolved.length ? total / resolved.length : null,
    pnlPer100: total * 100,
  };
}

const pct = (value: number | null) =>
  value === null ? "–" : `${value >= 0 ? "+" : ""}${Math.round(value * 100)}%`;

export function renderTrackRecord(record: TrackRecord, now: Date): string {
  const { signals, resolved, won } = record;
  const lines = [
    "# Datadash Polymarket Analytics: track record",
    "",
    `Every signal sent to OKX.AI subscribers, scored against the market. Updated ${now.toISOString().slice(0, 16).replace("T", " ")} UTC.`,
    "Returns are per dollar at the signal's order price. Open signals are marked to the current price and are not in the totals.",
    "",
    `- Signals sent: **${signals.length}**`,
    `- Settled: **${resolved}**, won **${won}**${resolved ? ` (${Math.round((won / resolved) * 100)}%)` : ""}`,
    `- Average settled return: **${pct(record.avgReturn)}**`,
    `- $100 on every settled signal: **${record.pnlPer100 >= 0 ? "+" : "-"}$${Math.abs(record.pnlPer100).toFixed(0)}**`,
    "",
    "| Sent (UTC) | Market | Side | Order price | Status | Return |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const s of [...signals].reverse()) {
    const question = s.question.replaceAll("|", "\\|");
    lines.push(
      `| ${s.createdAt.slice(0, 16).replace("T", " ")} | [${question}](${s.url}) | ${s.outcome.toUpperCase()} | ${s.orderPrice.toFixed(2)} | ${s.status} | ${pct(s.return)} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Each position's token as it stands now, read off its latest fill: the REST API has no token lookup, but every
 * activity row carries its token filled in, with the live price and whether the market has closed. One request
 * per position, a few at a time. A position with no fills, or whose request fails, is left out and scores as
 * unknown; `failed` counts the failures. Throws only when every request failed, since then the API is down.
 */
export async function fetchOutcomes(
  datadash: Datadash,
  positionIds: number[],
  concurrency = 5,
): Promise<{ tokens: Map<number, TokenOutcome>; failed: number }> {
  const tokens = new Map<number, TokenOutcome>();
  const ids = [...new Set(positionIds)];
  const errors: string[] = [];
  await pool(ids, concurrency, async (id) => {
    try {
      const [latest] = await datadash.list("/api/v1/activity", {
        filter: [{ field: "positionId", operator: "in", value: [id] }],
        orderBy: [{ field: "timestamp", direction: "desc" }],
        page: { limit: 1, offset: 0 },
      });
      const token = latest?.token;
      if (!token) return;
      tokens.set(id, {
        positionId: id,
        tokenPrice: Number(token.tokenPrice),
        marketClosed: token.marketClosed === true,
      });
    } catch (error) {
      errors.push((error as Error).message);
    }
  });
  if (ids.length && errors.length === ids.length)
    throw new Error(`every outcome lookup failed, first error: ${errors[0]}`);
  return { tokens, failed: errors.length };
}

/**
 * Outcomes already settled in the previous report. A won or lost market never changes, so those signals need
 * no request; only open and unknown ones are looked up again, which keeps the run short as history grows.
 */
export async function settledOutcomes(path: string): Promise<Map<number, TokenOutcome>> {
  const settled = new Map<number, TokenOutcome>();
  let previous: TrackRecord;
  try {
    previous = JSON.parse(await readFile(path, "utf8")) as TrackRecord;
  } catch {
    return settled;
  }
  for (const signal of previous.signals ?? []) {
    if (signal.status !== "won" && signal.status !== "lost") continue;
    const positionId = Number(signal.id);
    settled.set(positionId, { positionId, tokenPrice: signal.status === "won" ? 1 : 0, marketClosed: true });
  }
  return settled;
}

/** Looks up every sent signal's token and writes the track record as Markdown and JSON. */
export async function writeTrackRecord(
  datadash: Datadash,
  history: HistoryItem[],
  dir: string,
  now = new Date(),
): Promise<TrackRecord> {
  const settled = await settledOutcomes(`${dir}/track-record.json`);
  const { tokens, failed } = await fetchOutcomes(
    datadash,
    history.map((item) => Number(item.id)).filter((id) => !settled.has(id)),
  );
  for (const [id, token] of settled) tokens.set(id, token);
  const record = { ...scoreHistory(history, tokens), lookupsFailed: failed };
  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}/track-record.md`, renderTrackRecord(record, now));
  await writeFile(
    `${dir}/track-record.json`,
    `${JSON.stringify(record, null, 2)}\n`,
  );
  return record;
}
