/**
 * TickVPN pricing model — see /docs/pricing-model.md for the full
 * writeup (formula derivation, market positioning, admin override spec).
 *
 * Every Tick Pass is priced off one power-curve formula, calibrated to a
 * single anchor point (3-hour pass = $0.49). Cost-per-minute drops smoothly
 * as duration increases — no hand-set discount table, no discontinuities.
 *
 *   price($) = BASE_RATE × minutes ^ DECAY_EXP
 *
 * TICK_PASS_TIERS below holds the 10 named tiers from the pricing doc, with
 * their doc-published, psychologically-rounded prices ($0.19, $0.29, ...,
 * $69.99) rather than the raw formula output — real retail prices get
 * rounded to conventional endings, so these are the source of truth for the
 * *named* tiers. `formulaPriceCents` is the source of truth for anything
 * else: custom/arbitrary minute amounts, and the smooth curve drawn on the
 * landing page (the named tiers sit a few % off the raw curve because of
 * that rounding — expected, not a bug).
 *
 * Admin overrides (see pricing doc's `pricing_overrides` table) are NOT
 * implemented yet — no admin auth exists in this build. When they are, they
 * slot in at the top of `formulaPriceCents` and as a lookup keyed by
 * tier minutes in `priceForTier`, without changing any caller.
 */

export const BASE_RATE = 0.01958;
export const DECAY_EXP = 0.62;

export interface TickPassTier {
  name: string;
  minutes: number;
  priceCents: number;
}

export const TICK_PASS_TIERS: TickPassTier[] = [
  { name: "30 Min Pass", minutes: 30, priceCents: 19 },
  { name: "1 Hour Pass", minutes: 60, priceCents: 29 },
  { name: "3 Hour Pass", minutes: 180, priceCents: 49 }, // anchor
  { name: "6 Hour Pass", minutes: 360, priceCents: 79 },
  { name: "12 Hour Pass", minutes: 720, priceCents: 119 },
  { name: "24 Hour Pass", minutes: 1440, priceCents: 179 },
  { name: "1 Week Pass", minutes: 10080, priceCents: 599 },
  { name: "15 Day Pass", minutes: 21600, priceCents: 999 },
  { name: "30 Day Pass", minutes: 43200, priceCents: 1499 },
  { name: "Annual Pass", minutes: 525600, priceCents: 6999 },
];

/** Raw formula output, in cents. Used for custom amounts and the curve chart. */
export function formulaPriceCents(minutes: number): number {
  if (minutes <= 0) return 0;
  const dollars = BASE_RATE * Math.pow(minutes, DECAY_EXP);
  return Math.max(1, Math.round(dollars * 100));
}

/** Doc-published price if `minutes` matches a named tier exactly, else the live formula. */
export function priceForMinutesCents(minutes: number): number {
  const tier = TICK_PASS_TIERS.find((t) => t.minutes === minutes);
  return tier ? tier.priceCents : formulaPriceCents(minutes);
}
