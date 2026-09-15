import type { Thresholds } from "./config.ts";
import type { Datadash } from "./datadash.ts";

/** One row of Datadash's signalScore table: a top wallet's currently-held outcome position. */
export type PositionRow = {
  userId: string;
  positionId: number;
  marketId: number;
  avgEntryPrice: number;
  pNow: number;
  tradeSize: number;
  relSize: number;
  score: number;
};

/** The outcome token a position is in, from the token lookup. */
export type TokenInfo = {
  positionId: number;
  marketQuestion: string;
  marketSlug: string;
  eventSlug: string;
  tokenName: string;
  tokenId: string;
  marketEndDate: string | null;
  marketClosed: boolean;
};

export type TraderInfo = {
  userId: string;
  displayName: string | null;
  pseudonym: string | null;
  rank: number | null;
};

export type SignalTrader = {
  wallet: string;
  name: string;
  rank: number | null;
  entryPrice: number;
  tradeUsd: number;
  relSize: number;
  score: number;
};

export type Signal = {
  /** One signal per outcome token, so the same bet is never sent twice. */
  id: string;
  marketId: number;
  question: string;
  slug: string;
  eventSlug: string;
  /** Outcome to buy, as Polymarket names it (Yes / No, or a categorical outcome). */
  outcome: string;
  tokenId: string;
  /** YYYY-MM-DD, or null when the market has no end date. */
  settlement: string | null;
  priceNow: number;
  /** Limit price: never more than maxChase above what the top traders paid. */
  orderPrice: number;
  positionPct: number;
  score: number;
  traders: SignalTrader[];
};

const round2 = (value: number) => Math.round(value * 100) / 100;

const easternDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * The last day of trading, as the market's question states it. Datadash stores end dates in UTC and Polymarket
 * closes markets at midnight US Eastern, so "by December 31" ends at 2027-01-01 05:00 UTC. One minute before the
 * close, in Eastern time, is December 31.
 */
export function settlementDate(endDateUtc: string | null): string | null {
  if (!endDateUtc) return null;
  const end = new Date(`${endDateUtc.replace(" ", "T")}Z`);
  if (Number.isNaN(end.getTime())) return null;
  return easternDate.format(new Date(end.getTime() - 60_000));
}

export function signalQuery(t: Thresholds, limit = 100) {
  return {
    filter: [
      { field: "userRank", operator: "lte", value: t.maxTraderRank },
      { field: "score", operator: "gte", value: t.minScore },
      { field: "relSize", operator: "gte", value: t.minRelSize },
      { field: "tradeSize", operator: "gte", value: t.minTradeUsd },
      { field: "pNow", operator: "gte", value: t.minPrice },
      { field: "pNow", operator: "lte", value: t.maxPrice },
      { field: "slipAbs", operator: "lte", value: t.maxChase },
      { field: "daysToResolution", operator: "gte", value: 1 },
      { field: "daysToResolution", operator: "lte", value: t.maxDaysLeft },
    ],
    orderBy: [{ field: "score", direction: "desc" }],
    page: { limit, offset: 0 },
  };
}

/**
 * Groups top-trader positions into one signal per outcome token, ranked by conviction. A market where top
 * traders hold both sides is dropped: there is no clear side to copy.
 */
export function buildSignals(
  rows: PositionRow[],
  tokens: Map<number, TokenInfo>,
  traders: Map<string, TraderInfo>,
  t: Thresholds,
): Signal[] {
  const byPosition = new Map<number, PositionRow[]>();
  for (const row of rows) {
    const token = tokens.get(row.positionId);
    if (!token || token.marketClosed) continue;
    byPosition.set(row.positionId, [
      ...(byPosition.get(row.positionId) ?? []),
      row,
    ]);
  }

  const sidesPerMarket = new Map<number, Set<number>>();
  for (const [positionId, group] of byPosition) {
    const marketId = group[0].marketId;
    sidesPerMarket.set(
      marketId,
      (sidesPerMarket.get(marketId) ?? new Set()).add(positionId),
    );
  }

  const signals: Signal[] = [];
  for (const [positionId, group] of byPosition) {
    if ((sidesPerMarket.get(group[0].marketId)?.size ?? 0) > 1) continue;
    const token = tokens.get(positionId)!;

    const totalUsd = group.reduce((sum, row) => sum + row.tradeSize, 0);
    const entry =
      group.reduce((sum, row) => sum + row.avgEntryPrice * row.tradeSize, 0) /
      totalUsd;
    const priceNow = group[0].pNow;
    const orderPrice = Math.min(
      0.99,
      Math.max(0.01, round2(Math.min(priceNow + 0.01, entry + t.maxChase))),
    );
    const score = Math.max(...group.map((row) => row.score));
    const maxRelSize = Math.max(...group.map((row) => row.relSize));

    signals.push({
      id: String(positionId),
      marketId: group[0].marketId,
      question: token.marketQuestion,
      slug: token.marketSlug,
      eventSlug: token.eventSlug,
      outcome: token.tokenName,
      tokenId: token.tokenId,
      settlement: settlementDate(token.marketEndDate),
      priceNow,
      orderPrice,
      positionPct:
        score >= 95 && (group.length > 1 || maxRelSize >= 10) ? 3 : 2,
      score,
      traders: group
        .map((row) => {
          const info = traders.get(row.userId);
          return {
            wallet: row.userId,
            name:
              info?.displayName ||
              info?.pseudonym ||
              `${row.userId.slice(0, 6)}…${row.userId.slice(-4)}`,
            rank: info?.rank ?? null,
            entryPrice: row.avgEntryPrice,
            tradeUsd: row.tradeSize,
            relSize: row.relSize,
            score: row.score,
          };
        })
        .sort((a, b) => b.tradeUsd - a.tradeUsd),
    });
  }

  const totalUsd = (signal: Signal) =>
    signal.traders.reduce((sum, trader) => sum + trader.tradeUsd, 0);
  return signals.sort(
    (a, b) =>
      b.score - a.score ||
      b.traders.length - a.traders.length ||
      totalUsd(b) - totalUsd(a),
  );
}

/** Pulls the live top-trader positions from Datadash and turns them into ranked signals. */
export async function fetchSignals(
  datadash: Datadash,
  t: Thresholds,
): Promise<Signal[]> {
  const rows = (await datadash.queryTable(
    "signalScore",
    signalQuery(t),
  )) as unknown as PositionRow[];
  if (!rows.length) return [];

  const positionIds = [...new Set(rows.map((row) => row.positionId))];
  const userIds = [...new Set(rows.map((row) => row.userId))];
  const [tokenRows, userRows] = await Promise.all([
    datadash.queryLookup("signalScore", "positionId", {
      filter: [{ field: "positionId", operator: "in", value: positionIds }],
      page: { limit: positionIds.length, offset: 0 },
    }),
    datadash.queryLookup("signalScore", "userId", {
      filter: [{ field: "userId", operator: "in", value: userIds }],
      page: { limit: userIds.length, offset: 0 },
    }),
  ]);

  const tokens = new Map(
    (tokenRows as unknown as TokenInfo[]).map((token) => [
      Number(token.positionId),
      token,
    ]),
  );
  const traders = new Map(
    (userRows as unknown as TraderInfo[]).map((user) => [user.userId, user]),
  );
  return buildSignals(rows, tokens, traders, t);
}
