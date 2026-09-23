import type { Thresholds } from "./config.ts";
import { readToken, type Datadash, type ListBody, type ListRow } from "./datadash.ts";

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

/** OKX's Prediction format carries a YES/NO direction, so only those outcomes can become signals. The backtest uses it too. */
export const isBinaryOutcome = (tokenName: string) => /^(yes|no)$/i.test(tokenName);

/** An id the rest of the pipeline keys on. Missing, it would turn into NaN and silently match nothing, so it throws. */
const requireId = (value: number | null | undefined, what: string, row: unknown): number => {
  if (value === undefined || value === null || !Number.isFinite(Number(value)))
    throw new Error(`Datadash row without ${what}: ${JSON.stringify(row).slice(0, 200)}`);
  return Number(value);
};

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

/**
 * The candidate positions: the top `limit` by Datadash score, then by bet size, from any wallet unless
 * `maxTriggerRank` narrows it. The score already weighs the wallet; the smart-money consensus confirms later.
 */
export function signalQuery(t: Thresholds, limit = PAGE_LIMIT): ListBody<"/api/v1/signals/scores"> {
  return {
    filter: [
      ...(t.maxTriggerRank > 0
        ? [{ field: "userRank", operator: "lte", value: t.maxTriggerRank } as const]
        : []),
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
    orderBy: [
      { field: "score", direction: "desc" },
      { field: "tradeSize", direction: "desc" },
    ],
    page: { limit, offset: 0 },
  };
}

const shortAddress = (wallet: string) => `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;

/** The trader's Polymarket name, or a short address when the name is only an address with a suffix. */
export function traderName(info: TraderInfo | undefined, wallet: string): string {
  const name = info?.displayName || info?.pseudonym || "";
  return !name || /^0x[0-9a-f]{20,}/i.test(name) ? shortAddress(wallet) : name;
}

/** `${wallet}:${positionId}` → when that wallet last bought that position. */
export type LastTraded = Map<string, string>;

/** Datadash's page cap. */
export const PAGE_LIMIT = 1000;
const MAX_BUY_PAGES = 10;

const tradeKey = (userId: string, positionId: number) =>
  `${userId}:${positionId}`;


/**
 * The latest buy per wallet and position, from Datadash `activity` rows. Buys only: a sell also moves a
 * position's last-trade time, and a trader trimming a bet is not news. Throws rather than returning a map that
 * would silently fail every signal, when the rows no longer carry the fields we read.
 */
export function lastBuys(rows: ListRow<"/api/v1/activity">[]): LastTraded {
  const last: LastTraded = new Map();
  for (const row of rows) {
    const at = String(row.timestamp);
    const wallet = row.user?.userId;
    const positionId = row.token?.positionId;
    if (!wallet || positionId === undefined || Number.isNaN(parseUtc(at).getTime()))
      throw new Error(`Datadash activity row without wallet, position or timestamp: ${JSON.stringify(row).slice(0, 200)}`);
    const key = tradeKey(wallet, positionId);
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
    // OKX's Prediction format carries a YES/NO direction; a named outcome ("Real Madrid") can't be expressed.
    if (!isBinaryOutcome(token.tokenName)) continue;
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
            name: traderName(info, row.userId),
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
    // The table describes only the side it favors; a signal on the other side has no consensus behind it.
    if (row.side.toLowerCase() !== signal.outcome.toLowerCase()) return [];
    const share = row.smartMoneyPrice;
    if (
      share < t.minConsensusShare ||
      row.wallets < t.minConsensusWallets ||
      row.atRisk < t.minConsensusUsd
    )
      return [];
    return [
      {
        ...signal,
        consensus: { share, wallets: row.wallets, atRiskUsd: row.atRisk },
      },
    ];
  });
}

/**
 * Splits signalScore rows into the position rows `buildSignals` ranks and the trader and token each row already
 * carries: the REST API fills in `user` and `token` on every row, so there is nothing to look up separately.
 */
export function fromSignalRows(raw: ListRow<"/api/v1/signals/scores">[]): {
  rows: PositionRow[];
  tokens: Map<number, TokenInfo>;
  traders: Map<string, TraderInfo>;
} {
  const rows: PositionRow[] = [];
  const tokens = new Map<number, TokenInfo>();
  const traders = new Map<string, TraderInfo>();
  for (const item of raw) {
    const user = item.user;
    const token = readToken(item.token);
    if (!user?.userId || !token)
      throw new Error(`Datadash signal row without user or token: ${JSON.stringify(item).slice(0, 200)}`);
    const row: PositionRow = {
      userId: user.userId,
      positionId: token.positionId,
      marketId: requireId(item.market?.id ?? token.marketId, "market id", item),
      eventId: requireId(item.event?.id ?? token.eventId, "event id", item),
      avgEntryPrice: Number(item.avgEntryPrice),
      pNow: Number(item.pNow),
      tradeSize: Number(item.tradeSize),
      relSize: Number(item.relSize),
      score: Number(item.score),
    };
    rows.push(row);
    tokens.set(row.positionId, token);
    traders.set(row.userId, {
      userId: user.userId,
      displayName: user.displayName ?? null,
      pseudonym: user.pseudonym ?? null,
      rank: user.rank ?? null,
    });
  }
  return { rows, tokens, traders };
}

/** Pulls the live top-trader positions from Datadash and turns them into ranked signals: two or three REST calls. */
export async function fetchSignals(
  datadash: Datadash,
  t: Thresholds,
): Promise<Signal[]> {
  const { rows, tokens, traders } = fromSignalRows(
    await datadash.list("/api/v1/signals/scores", signalQuery(t)),
  );
  if (!rows.length) return [];

  // Cheap checks first. The top-500 agreement is one request for every candidate market and drops most of them;
  // only the survivors need their recent buys, which is the slow, paged request. Same result as checking
  // freshness first: both-sided markets are dropped before either check, and each check is per signal.
  const candidates = buildSignals(rows, tokens, traders, t);
  if (!candidates.length) return [];
  const consensus = consensusRows(
    await datadash.list("/api/v1/smart-money/global", smartMoneyQuery(t, candidates)),
  );
  const agreed = new Set(applyConsensus(candidates, consensus, t).map((signal) => signal.id));
  if (!agreed.size) return [];
  const kept = rows.filter((row) => agreed.has(String(row.positionId)));

  const signals = buildSignals(kept, tokens, traders, t, {
    lastTraded: lastBuys(await recentBuys(datadash, t, kept)),
    now: new Date(),
  });
  return applyConsensus(signals, consensus, t);
}

/** The top-500 wallets' money on each candidate's market, over the same wallet set the consensus rule names. */
function smartMoneyQuery(t: Thresholds, signals: Signal[]): ListBody<"/api/v1/smart-money/global"> {
  const marketIds = [...new Set(signals.map((signal) => signal.marketId))];
  return {
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
  };
}

/** Recent buys by these rows' wallets into these rows' positions, for freshness. Paged; pairs outside `rows` are ignored. */
export async function recentBuys(
  datadash: Datadash,
  t: Thresholds,
  rows: PositionRow[],
): Promise<ListRow<"/api/v1/activity">[]> {
  const positionIds = [...new Set(rows.map((row) => row.positionId))];
  const userIds = [...new Set(rows.map((row) => row.userId))];
  const buys: ListRow<"/api/v1/activity">[] = [];
  for (let page = 0; ; page++) {
    if (page === MAX_BUY_PAGES)
      throw new Error(`more than ${MAX_BUY_PAGES * PAGE_LIMIT} recent buys; freshness would be incomplete`);
    const batch = await datadash.list("/api/v1/activity", {
      activities: ["Buy"],
      filter: [
        { field: "wallet", operator: "in", value: userIds },
        { field: "positionId", operator: "in", value: positionIds },
        { field: "timestamp", operator: "last", value: { length: Math.ceil(t.maxPositionAgeDays), unit: "day" } },
      ],
      orderBy: [{ field: "timestamp", direction: "desc" }],
      page: { limit: PAGE_LIMIT, offset: page * PAGE_LIMIT },
    });
    buys.push(...batch);
    if (batch.length < PAGE_LIMIT) return buys;
  }
}

/** globalSmartMoney rows carry their market as a filled-in `market`; the consensus check keys on its id. */
export const consensusRows = (raw: ListRow<"/api/v1/smart-money/global">[]): ConsensusRow[] =>
  raw.map((row) => ({
    marketId: requireId(row.market?.id, "market", row),
    side: String(row.side),
    smartMoneyPrice: Number(row.smartMoneyPrice),
    wallets: Number(row.wallets),
    atRisk: Number(row.atRisk),
  }));
