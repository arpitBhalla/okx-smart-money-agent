import type { Signal } from "./signals.ts";

/** OKX.AI's limit for one delivered signal. */
export const MAX_SIGNAL_LENGTH = 200;

const price = (value: number) => value.toFixed(2);

/**
 * The signal exactly as OKX.AI's Prediction format spells it, so a subscriber's agent can parse it and place
 * the order with the Polymarket plugin:
 *
 *   【Prediction】"<question>" | YES | Limit | Order Price 0.60 | Position 5% | Settlement 2026-09-18 | Valid for 2h
 *
 * The question is shortened with an ellipsis when the whole line would pass 200 characters.
 */
export function formatSignal(signal: Signal, validHours: number): string {
  const tail = [
    signal.outcome.toUpperCase(),
    "Limit",
    `Order Price ${price(signal.orderPrice)}`,
    `Position ${signal.positionPct}%`,
    ...(signal.settlement ? [`Settlement ${signal.settlement}`] : []),
    `Valid for ${validHours}h`,
  ].join(" | ");

  const head = '【Prediction】"';
  const room = MAX_SIGNAL_LENGTH - head.length - `" | ${tail}`.length;
  const question =
    signal.question.length > room
      ? `${signal.question.slice(0, room - 1).trimEnd()}…`
      : signal.question;
  return `${head}${question}" | ${tail}`;
}

const usd = (value: number) =>
  value >= 1e6
    ? `$${(value / 1e6).toFixed(2)}M`
    : value >= 1e3
      ? `$${(value / 1e3).toFixed(1)}K`
      : `$${value.toFixed(0)}`;

/** Why the signal fired, for logs and the demo. Never delivered: OKX caps a signal at 200 characters. */
export function explainSignal(signal: Signal): string {
  const lead = signal.traders[0];
  const others = signal.traders.length - 1;
  const who = `${lead.name}${lead.rank ? ` (rank #${lead.rank})` : ""}`;
  return [
    `${who} holds ${usd(lead.tradeUsd)} of ${signal.outcome} at ${price(lead.entryPrice)},`,
    `${lead.relSize.toFixed(1)}x their usual size.`,
    `Signal score ${Math.round(signal.score)}.`,
    others > 0
      ? `${others} more top-500 trader${others > 1 ? "s" : ""} on the same side.`
      : "",
    `Now ${price(signal.priceNow)}. https://polymarket.com/event/${signal.eventSlug}/${signal.slug}`,
  ]
    .filter(Boolean)
    .join(" ");
}
