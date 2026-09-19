import type { Thresholds } from "./config.ts";
import type { Datadash } from "./datadash.ts";

/** One row of Datadash's signalScore table: a top wallet's currently-held outcome position. */
export type PositionRow = {
  userId: string;
  positionId: number;
  marketId: number;
  eventId: number;
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
  /** When this trader last bought the position, or null when there is no buy in the freshness window. */
  lastTradedAt: string | null;
};

export type Signal = {
  /** One signal per outcome token, so the same bet is never sent twice. */
  id: string;
  marketId: number;
  eventId: number;
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
  /** How top-ranked wallets' money on this market leans, when the consensus check ran. */
  consensus?: Consensus;
};

/** One market in Datadash's globalSmartMoney table, over the top-ranked wallets only. */
export type ConsensusRow = {
  marketId: number;
  /** The outcome that wallet set favors, as Polymarket names it. */
  side: string;
  /** Share of the wallet set's money on `side`, 0-1. Not a probability: 0.97 means 97% of their money. */
  smartMoneyPrice: number;
  wallets: number;
  atRisk: number;
};

export type Consensus = { share: number; wallets: number; atRiskUsd: number };

const round2 = (value: number) => Math.round(value * 100) / 100;

/** Datadash timestamps are UTC without a zone: "2026-09-19 16:31:33". */
export const parseUtc = (value: string) =>
  new Date(`${value.replace(" ", "T")}Z`);

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
  const end = parseUtc(endDateUtc);
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
      { field: "slipAbs", operator: "gte", value: -t.maxDrop },
      { field: "daysToResolution", operator: "gte", value: 1 },
      { field: "daysToResolution", operator: "lte", value: t.maxDaysLeft },
    ],
    orderBy: [{ field: "score", direction: "desc" }],
    page: { limit, offset: 0 },
  };
}

/** `${wallet}:${positionId}` → when that wallet last bought that position. */
export type LastTraded = Map<string, string>;

const tradeKey = (userId: string, positionId: number) =>
  `${userId}:${positionId}`;

/** Datadash's page cap. A full page means rows were cut off, so the caller must not trust it as complete. */
export const PAGE_LIMIT = 1000;

/**
 * The latest buy per wallet and position, from Datadash `activity` rows. Buys only: a sell also moves a
 * position's last-trade time, and a trader trimming a bet is not news. Throws rather than returning a map that
 * would silently fail every signal: on a full page, or when the rows no longer carry the fields we read.
 */
export function lastBuys(rows: Record<string, unknown>[]): LastTraded {
  if (rows.length >= PAGE_LIMIT)
    throw new Error(`Datadash returned a full page of ${PAGE_LIMIT} buys; freshness would be incomplete`);
  const last: LastTraded = new Map();
  for (const row of rows) {
    const at = String(row.timestamp);
    if (!row.wallet || Number.isNaN(parseUtc(at).getTime()))
      throw new Error(`Datadash activity row without wallet or timestamp: ${JSON.stringify(row).slice(0, 200)}`);
    const key = tradeKey(String(row.wallet), Number(row.positionId));
    if (!last.has(key) || parseUtc(at) > parseUtc(last.get(key)!)) last.set(key, at);
  }
  return last;
}

/**
 * Groups top-trader positions into one signal per outcome token, ranked by conviction. A market where top
 * traders hold both sides is dropped: there is no clear side to copy. With `activity`, a signal also needs at
 * least one of its traders to have bought into the position in the last `maxPositionAgeDays`, so an old holding
 * that happens to qualify is not sent as news. Both sides are counted before that check, so a stale holder on
 * the other side still blocks the market.
 */
export function buildSignals(
  rows: PositionRow[],
  tokens: Map<number, TokenInfo>,
  traders: Map<string, TraderInfo>,
  t: Thresholds,
  activity?: { lastTraded: LastTraded; now: Date },
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
    const lastTradedAt = (row: PositionRow) =>
      activity?.lastTraded.get(tradeKey(row.userId, row.positionId)) ?? null;
    if (activity) {
      const cutoff =
        activity.now.getTime() - t.maxPositionAgeDays * 86_400_000;
      const fresh = group.some((row) => {
        const at = lastTradedAt(row);
        return at !== null && parseUtc(at).getTime() >= cutoff;
      });
      if (!fresh) continue;
    }

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
      eventId: group[0].eventId,
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
            lastTradedAt: lastTradedAt(row),
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

/**
 * Keeps the signals the wider smart money agrees with. The trigger is one top trader's unusual bet; this checks
 * that top-ranked wallets as a group hold at least `minConsensusShare` of their money on the same side, across at
 * least `minConsensusWallets` wallets. A market with no consensus row is dropped: nobody else is behind the bet.
 */
export function applyConsensus(
  signals: Signal[],
  rows: ConsensusRow[],
  t: Thresholds,
): Signal[] {
  const byMarket = new Map(rows.map((row) => [Number(row.marketId), row]));
  return signals.flatMap((signal) => {
    const row = byMarket.get(signal.marketId);
    if (!row) return [];
    // The table names only the favored side; on the other side the share is the rest, and its wallet count unknown.
    const favored = row.side.toLowerCase() === signal.outcome.toLowerCase();
    const share = favored ? row.smartMoneyPrice : 1 - row.smartMoneyPrice;
    if (!favored || share < t.minConsensusShare || row.wallets < t.minConsensusWallets)
      return [];
    return [
      {
        ...signal,
        consensus: { share, wallets: row.wallets, atRiskUsd: row.atRisk },
      },
    ];
  });
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
  const [tokenRows, userRows, buyRows] = await Promise.all([
    datadash.queryLookup("signalScore", "positionId", {
      filter: [{ field: "positionId", operator: "in", value: positionIds }],
      page: { limit: positionIds.length, offset: 0 },
    }),
    datadash.queryLookup("signalScore", "userId", {
      filter: [{ field: "userId", operator: "in", value: userIds }],
      page: { limit: userIds.length, offset: 0 },
    }),
    // Recent buys only, for freshness. Pairs outside `rows` are ignored.
    datadash.queryTable("activity", {
      activities: ["Buy"],
      filter: [
        { field: "wallet", operator: "in", value: userIds },
        { field: "positionId", operator: "in", value: positionIds },
        { field: "timestamp", operator: "last", value: { length: Math.ceil(t.maxPositionAgeDays), unit: "day" } },
      ],
      orderBy: [{ field: "timestamp", direction: "desc" }],
      page: { limit: PAGE_LIMIT, offset: 0 },
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
  const signals = buildSignals(rows, tokens, traders, t, {
    lastTraded: lastBuys(buyRows),
    now: new Date(),
  });
  if (!signals.length) return [];

  const marketIds = [...new Set(signals.map((signal) => signal.marketId))];
  const consensus = await datadash.queryTable("globalSmartMoney", {
    // Evaluate the consensus over the same top-ranked wallets the signals come from, not every wallet.
    walletFilters: [
      {
        field: "userId",
        operator: "userProfileLookup",
        value: {
          duration: { operator: "in", value: ["ALL"] },
          filter: [{ field: "rank", operator: "lte", value: t.maxTraderRank }],
        },
      },
    ],
    filter: [{ field: "marketId", operator: "in", value: marketIds }],
    page: { limit: marketIds.length, offset: 0 },
  });
  return applyConsensus(signals, consensus as unknown as ConsensusRow[], t);
}
