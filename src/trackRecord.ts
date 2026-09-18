import { mkdir, writeFile } from "node:fs/promises";
import type { Datadash } from "./datadash.ts";
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
    "# Datadash Smart Money: track record",
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

/** Looks up every sent signal's token and writes the track record as Markdown and JSON. */
export async function writeTrackRecord(
  datadash: Datadash,
  history: HistoryItem[],
  dir: string,
  now = new Date(),
): Promise<TrackRecord> {
  const ids = [...new Set(history.map((item) => Number(item.id)))];
  const tokens = new Map<number, TokenOutcome>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = await datadash.queryLookup("signalScore", "positionId", {
      filter: [{ field: "positionId", operator: "in", value: chunk }],
      page: { limit: chunk.length, offset: 0 },
    });
    for (const row of rows as unknown as TokenOutcome[])
      tokens.set(Number(row.positionId), row);
  }

  const record = scoreHistory(history, tokens);
  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}/track-record.md`, renderTrackRecord(record, now));
  await writeFile(
    `${dir}/track-record.json`,
    `${JSON.stringify(record, null, 2)}\n`,
  );
  return record;
}
