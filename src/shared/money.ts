/**
 * Money is stored as whole paise (₹1 = 100 paise) in integers, so totals never suffer floating-point drift
 * (0.1 + 0.2 !== 0.3). Rupee amounts only exist at the edges: tool input and display text.
 */

/** Upper bound for a single entry (₹1 crore). Catches slips like an extra zero or a phone number typed as an amount. */
export const MAX_ENTRY_RUPEES = 10_000_000;

/** True when the rupee amount has at most 2 decimal places (tolerates binary floating-point noise such as 19.99). */
export function hasAtMostTwoDecimals(rupees: number): boolean {
  const scaled = rupees * 100;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
}

/** Converts a validated rupee amount to integer paise. Throws on values the caller should have rejected. */
export function rupeesToPaise(rupees: number): number {
  if (!Number.isFinite(rupees) || rupees <= 0 || !hasAtMostTwoDecimals(rupees)) {
    throw new RangeError(`Invalid rupee amount: ${rupees}`);
  }
  const paise = Math.round(rupees * 100);
  if (!Number.isSafeInteger(paise)) throw new RangeError(`Rupee amount too large: ${rupees}`);
  return paise;
}

const inrFormatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Formats integer paise for display using Indian digit grouping, e.g. 250000000 -> "₹25,00,000.00". */
export function formatPaise(paise: number): string {
  if (!Number.isSafeInteger(paise)) throw new RangeError(`Paise must be a safe integer: ${paise}`);
  return inrFormatter.format(paise / 100);
}
