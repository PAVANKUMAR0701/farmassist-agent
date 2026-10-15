/**
 * Verified-number guard: checks that every number in a piece of generated text appears in the facts
 * that were calculated by code. It is deterministic and does not trust the model's instructions.
 *
 * What counts as allowed is read from the facts by field name:
 *   - `*Paise` fields  -> money, allowed as exact rupees (₹3,450.25) or rounded to whole rupees (₹3,450)
 *   - `*Percent` fields -> percentages, only when written with % / percent
 *   - `*Count` fields   -> counts, allowed as bare numbers
 *   - ISO date strings  -> dates written as YYYY-MM-DD
 *
 * Known limits (also in docs/number-guard.md): dates in other formats ("14 October") are rejected because
 * their parts look like unsupported numbers; number words are only recognised for two..twelve, and
 * magnitude words (hundred, thousand, lakh, crore, million) are always rejected; "one" is not checked
 * because it is usually a pronoun; ordinal and relative words ("first", "half", "double") are not checked.
 */

export type ClaimKind = 'money' | 'percent' | 'plain' | 'date' | 'word';

export interface NumericClaim {
  raw: string;
  kind: ClaimKind;
  /** Numeric value (rupees for money). Undefined for dates and magnitude words. */
  value?: number;
}

export interface GuardResult {
  ok: boolean;
  claims: NumericClaim[];
  /** The raw text of every claim not supported by the facts. */
  unsupported: string[];
}

const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/g;
// Optional rupee prefix, a number with optional thousands separators (Indian or Western) and decimals,
// then an optional unit suffix.
const NUMBER =
  /(?<prefix>₹|\bRs\.?|\bINR)?\s?(?<num>\d(?:[\d,]*\d)?(?:\.\d+)?)(?:\s?(?<suffix>%|percent\b|per cent\b|rupees?\b|Rs\b))?/giu;
const SMALL_WORDS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
const WORD = /\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|hundreds?|thousands?|lakhs?|crores?|millions?)\b/gi;

/** Finds every numeric claim in the text. */
export function extractNumericClaims(text: string): NumericClaim[] {
  const claims: NumericClaim[] = [];
  const withoutDates = text.replace(ISO_DATE, (raw) => {
    claims.push({ raw, kind: 'date' });
    return ' ';
  });

  for (const match of withoutDates.matchAll(NUMBER)) {
    const { prefix, num, suffix } = match.groups!;
    const value = Number(num!.replace(/,/g, ''));
    const unit = suffix?.toLowerCase();
    const kind: ClaimKind =
      unit === '%' || unit === 'percent' || unit === 'per cent' ? 'percent' : prefix || unit ? 'money' : 'plain';
    claims.push({ raw: match[0].trim(), kind, value });
  }

  for (const match of withoutDates.matchAll(WORD)) {
    const word = match[0].toLowerCase();
    const value = SMALL_WORDS[word];
    claims.push(value === undefined ? { raw: match[0], kind: 'word' } : { raw: match[0], kind: 'plain', value });
  }
  return claims;
}

interface AllowedValues {
  /** Money and other values are compared in hundredths, so 3450.25 and 345025 paise line up exactly. */
  moneyCents: Set<number>;
  percents: Set<number>;
  counts: Set<number>;
  dates: Set<string>;
}

const toCents = (value: number) => Math.round(value * 100);

/** Walks the facts object and collects the allowed values by field name. */
export function allowedValuesFrom(facts: unknown): AllowedValues {
  const allowed: AllowedValues = { moneyCents: new Set(), percents: new Set(), counts: new Set(), dates: new Set() };
  const visit = (value: unknown, key: string) => {
    if (Array.isArray(value)) return value.forEach((v) => visit(v, key));
    if (value && typeof value === 'object') return Object.entries(value).forEach(([k, v]) => visit(v, k));
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) allowed.dates.add(value);
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    if (/Paise$/.test(key)) {
      allowed.moneyCents.add(value); // paise are already hundredths of a rupee
      allowed.moneyCents.add(Math.round(value / 100) * 100); // whole-rupee rounding
    } else if (/Percent$/.test(key)) {
      allowed.percents.add(toCents(value));
    } else if (/Count$/i.test(key)) {
      allowed.counts.add(toCents(value));
    }
  };
  visit(facts, '');
  return allowed;
}

export function checkNumbers(text: string, facts: unknown): GuardResult {
  const allowed = allowedValuesFrom(facts);
  const claims = extractNumericClaims(text);
  const unsupported = claims
    .filter((claim) => {
      switch (claim.kind) {
        case 'date':
          return !allowed.dates.has(claim.raw);
        case 'money':
          return !allowed.moneyCents.has(toCents(claim.value!));
        case 'percent':
          return !allowed.percents.has(toCents(claim.value!));
        case 'plain': {
          const cents = toCents(claim.value!);
          return !allowed.counts.has(cents) && !allowed.moneyCents.has(cents);
        }
        case 'word':
          return true;
      }
    })
    .map((claim) => claim.raw);
  return { ok: unsupported.length === 0, claims, unsupported };
}
