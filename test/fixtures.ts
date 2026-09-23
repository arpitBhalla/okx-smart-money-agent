import type { Thresholds } from "../src/config.ts";
import type {
  PositionRow,
  Signal,
  TokenInfo,
  TraderInfo,
} from "../src/signals.ts";

export const thresholds: Thresholds = {
  maxTraderRank: 500,
  maxTriggerRank: 0,
  minScore: 80,
  minRelSize: 3,
  minTradeUsd: 5000,
  minPrice: 0.1,
  maxPrice: 0.9,
  maxChase: 0.03,
  maxDrop: 0.1,
  maxDaysLeft: 120,
  maxPositionAgeDays: 7,
  minConsensusShare: 0.6,
  minConsensusWallets: 3,
  minConsensusUsd: 10_000,
};

export const row = (over: Partial<PositionRow> = {}): PositionRow => ({
  userId: "0xaaa0000000000000000000000000000000000001",
  positionId: 1,
  marketId: 10,
  eventId: 100,
  avgEntryPrice: 0.41,
  pNow: 0.42,
  tradeSize: 20_000,
  relSize: 10,
  score: 100,
  ...over,
});

export const token = (over: Partial<TokenInfo> = {}): TokenInfo => ({
  positionId: 1,
  marketQuestion: "Will Ethereum dip to $2,250 by December 31, 2026?",
  marketSlug: "will-ethereum-dip-to-2250-by-december-31-2026",
  eventSlug: "what-price-will-ethereum-hit-in-2026",
  tokenName: "No",
  tokenId: "123",
  marketEndDate: "2026-12-31 12:00:00",
  marketClosed: false,
  ...over,
});

export const trader = (over: Partial<TraderInfo> = {}): TraderInfo => ({
  userId: "0xaaa0000000000000000000000000000000000001",
  displayName: "JnStrtPrdctnMrkts",
  pseudonym: null,
  rank: 237,
  ...over,
});

export const signal = (over: Partial<Signal> = {}): Signal => ({
  id: "1",
  marketId: 10,
  eventId: 100,
  question: "Will Ethereum dip to $2,250 by December 31, 2026?",
  slug: "will-ethereum-dip-to-2250-by-december-31-2026",
  eventSlug: "what-price-will-ethereum-hit-in-2026",
  outcome: "No",
  tokenId: "123",
  settlement: "2026-12-31",
  priceNow: 0.42,
  orderPrice: 0.43,
  positionPct: 3,
  score: 100,
  traders: [
    {
      wallet: "0xaaa",
      name: "JnStrtPrdctnMrkts",
      rank: 237,
      entryPrice: 0.41,
      tradeUsd: 20_000,
      relSize: 10,
      score: 100,
      lastTradedAt: "2026-09-21 10:00:00",
    },
  ],
  ...over,
});
