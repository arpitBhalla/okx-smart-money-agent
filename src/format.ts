import { parseUtc, type Signal } from "./signals.ts";

/** OKX.AI's limit for one delivered signal. */
export const MAX_SIGNAL_LENGTH = 200;

const price = (value: number) => value.toFixed(2);

/** "2h", or "45m" under an hour. Always rounded down, so a buyer never trades past the real expiry. */
export const validityLabel = (hours: number) =>
  hours >= 1 ? `${Math.floor(hours)}h` : `${Math.max(1, Math.floor(hours * 60))}m`;

/**
 * The signal exactly as OKX.AI's Prediction format spells it, so a subscriber's agent can parse it and place
 * the order with the Polymarket plugin:
 *
 *   【Prediction】"<question>" | YES | Limit | Order Price 0.60 | Position 5% | Settlement 2026-09-18 | Valid for 2h
 *
 * The question is shortened with an ellipsis when the whole line would pass 200 characters. `validHours` may be
 * fractional: the validity reads in whole hours, rounded down, and in minutes once less than an hour is left.
 */
export function formatSignal(signal: Signal, validHours: number): string {
  const tail = [
    signal.outcome.toUpperCase(),
    "Limit",
    `Order Price ${price(signal.orderPrice)}`,
    `Position ${signal.positionPct}%`,
    ...(signal.settlement ? [`Settlement ${signal.settlement}`] : []),
    `Valid for ${validityLabel(validHours)}`,
  ].join(" | ");

  const head = '【Prediction】"';
  // Counted in characters (code points), so a cut never splits an emoji or other astral character.
  const room = MAX_SIGNAL_LENGTH - [...head].length - [...`" | ${tail}`].length;
  const chars = [...safeQuestion(signal.question)];
  const question =
    chars.length > room
      ? `${chars.slice(0, room - 1).join("").trimEnd()}…`
      : chars.join("");
  return `${head}${question}" | ${tail}`;
}

/**
 * Market questions are written by whoever creates the market, so they can't be allowed to carry the line's
 * own separators: a question containing `| YES | Order Price 0.99` would read as extra fields to an agent that
 * parses the line by position. Pipes become slashes, double quotes single, line breaks and controls spaces.
 */
export function safeQuestion(question: string): string {
  return question
    .replaceAll("|", "/")
    .replaceAll('"', "'")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const usd = (value: number) =>
  value >= 1e6
    ? `$${(value / 1e6).toFixed(2)}M`
    : value >= 1e3
      ? `$${(value / 1e3).toFixed(1)}K`
      : `$${value.toFixed(0)}`;

export const marketUrl = (signal: Pick<Signal, "eventSlug" | "slug">) =>
  `https://polymarket.com/event/${signal.eventSlug}/${signal.slug}`;

/** What a winning share pays over its cost at the order price: 0.80 → +25%. */
export const upsidePct = (orderPrice: number) =>
  Math.round((1 / orderPrice - 1) * 100);

const ago = (at: string, now: Date) => {
  const hours = (now.getTime() - parseUtc(at).getTime()) / 3_600_000;
  return hours < 24
    ? `${Math.max(1, Math.round(hours))}h ago`
    : `${Math.round(hours / 24)}d ago`;
};

/** Why the signal fired, for logs and the demo. Never delivered: OKX caps a signal at 200 characters. */
export function explainSignal(signal: Signal, now = new Date()): string {
  const lead = signal.traders[0];
  const others = signal.traders.length - 1;
  const who = `${lead.name}${lead.rank ? ` (rank #${lead.rank})` : ""}`;
  const lastTraded = signal.traders
    .map((trader) => trader.lastTradedAt)
    .filter((at): at is string => at !== null)
    .sort()
    .at(-1);
  return [
    `${who} holds ${usd(lead.tradeUsd)} of ${signal.outcome} at ${price(lead.entryPrice)},`,
    `${lead.relSize.toFixed(1)}x their usual size.`,
    `Signal score ${Math.round(signal.score)}.`,
    others > 0
      ? `${others} more top-500 trader${others > 1 ? "s" : ""} on the same side.`
      : "",
    lastTraded ? `Last bought ${ago(lastTraded, now)}.` : "",
    signal.consensus
      ? `Top-500 money on this side: ${Math.round(signal.consensus.share * 100)}% across ${signal.consensus.wallets} wallets (${usd(signal.consensus.atRiskUsd)}).`
      : "",
    `Now ${price(signal.priceNow)}; pays +${upsidePct(signal.orderPrice)}% if right.`,
    marketUrl(signal),
  ]
    .filter(Boolean)
    .join(" ");
}
