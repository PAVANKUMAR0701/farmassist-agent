/**
 * Deterministic command parser: turns common farmer phrases into one MCP tool call without any model.
 * Used when no model is configured or the model fails, so the core ledger keeps working offline from Bedrock.
 *
 * It never guesses. If an amount or category is missing or unclear it asks instead of writing anything.
 */
import type { ActivityType } from '../domain/activity.js';
import type { ExpenseCategory } from '../domain/expense.js';
import type { NamedPeriod } from '../shared/time.js';

export type FallbackDecision =
  | { kind: 'tool'; name: string; args: Record<string, unknown> }
  | { kind: 'reply'; text: string };

export interface FallbackContext {
  /** entryId of the expense recorded or shown most recently in this conversation, for "no, it was 900". */
  lastExpenseId?: string | undefined;
}

export const FALLBACK_HELP =
  'I can record and look up farm records. Try: "spent 2500 on feed", "vaccinated the brown cow", ' +
  '"how much on feed this month", "today\'s summary", "show expenses this week", "weekly insights", ' +
  'or "no, it was 900" to fix the last expense.';

const CATEGORY_WORDS: Array<[ExpenseCategory, RegExp]> = [
  ['fodder', /\b(fodder|hay|straw|silage|green grass|dry grass)\b/],
  ['feed', /\b(feed|cattle feed|concentrate|bran|oil ?cake|khal)\b/],
  ['medicine', /\b(medicines?|vet|veterinary|doctor|injections?|dewormer|deworming|tablets?)\b/],
  ['labour', /\b(labou?r|wages?|workers?|salary|helper)\b/],
  ['fuel', /\b(diesel|petrol|fuel|kerosene)\b/],
  ['equipment', /\b(equipment|tools?|pump|repairs?|spare parts?|tractor parts?)\b/],
  ['seed', /\b(seeds?|saplings?)\b/],
];

const ACTIVITY_WORDS: Array<[ActivityType, RegExp]> = [
  ['vaccination', /\b(vaccinated|vaccinate|vaccination|vaccine given)\b/],
  ['milking', /\b(milked|milking|milk)\b/],
  ['sowing', /\b(sowed|sown|sowing|sow|planted|planting)\b/],
  ['harvesting', /\b(harvested|harvesting|harvest)\b/],
  ['irrigation', /\b(irrigated|irrigating|irrigation|watered)\b/],
];

const PERIOD_WORDS: Array<[NamedPeriod, RegExp]> = [
  ['last_7_days', /\b(last|past) (7|seven) days\b/],
  ['this_week', /\bthis week\b/],
  ['last_month', /\blast month\b/],
  ['this_month', /\bthis month\b/],
  ['yesterday', /\byesterday\b/],
  ['today', /\btoday\b/],
];

const ISO_DATE = /\b(\d{4}-\d{2}-\d{2})\b/;
/** An amount: digits with optional Indian/Western grouping and up to 2 decimals, optionally marked as rupees. */
const AMOUNT = /(?:₹|\brs\.?|\binr)\s*(\d[\d,]*(?:\.\d{1,2})?)|(\d[\d,]*(?:\.\d{1,2})?)\s*(?:rupees|rs\b|₹)?/;

function findAmount(text: string): number | undefined {
  const withoutDates = text.replace(ISO_DATE, ' ');
  const match = AMOUNT.exec(withoutDates);
  const raw = match?.[1] ?? match?.[2];
  if (!raw) return undefined;
  const value = Number(raw.replaceAll(',', ''));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

const firstMatch = <T>(table: Array<[T, RegExp]>, text: string): T | undefined => table.find(([, re]) => re.test(text))?.[0];

/** "vaccinated the brown cow today" -> "brown cow". */
function findSubject(text: string, verb: RegExp): string | undefined {
  const match = verb.exec(text);
  if (!match) return undefined;
  const subject = text
    .slice(match.index + match[0].length)
    .replace(/\b(today|yesterday|this morning|this evening|in the morning|in the evening)\b.*$/, '')
    .replace(ISO_DATE, '')
    .split(/[,.;]| with | for | on | at /)[0]!
    .replace(/^\s*(the|my|our|of|for)\s+/, '')
    .trim();
  return subject.length > 0 && subject.length <= 60 ? subject : undefined;
}

/** A date argument for writes: explicit YYYY-MM-DD, "yesterday", or omitted (today, decided by the server). */
function dateArg(text: string, today: string): Record<string, string> {
  const iso = ISO_DATE.exec(text)?.[1];
  if (iso) return { date: iso };
  if (/\byesterday\b/.test(text)) {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return { date: d.toISOString().slice(0, 10) };
  }
  return {};
}

/** Decides what to do with one message. `today` is the farm's date (YYYY-MM-DD, India time). */
export function decideFallback(message: string, context: FallbackContext, today: string): FallbackDecision {
  const original = message.trim();
  const text = original.toLowerCase().replace(/\s+/g, ' ');
  if (!text) return { kind: 'reply', text: FALLBACK_HELP };

  const amount = findAmount(text);
  const category = firstMatch(CATEGORY_WORDS, text);
  const period = firstMatch(PERIOD_WORDS, text);
  const note = original.slice(0, 200);

  // 1. Corrections: "no, it was 900", "correct the last expense to 900", "actually 900".
  if (/^(no\b|nahi|wrong|actually|correct\b|correction|change\b|fix\b)|\bit was\b|\bnot \d/.test(text)) {
    if (amount === undefined && !category) return { kind: 'reply', text: 'What should the corrected amount or category be?' };
    const changes = { ...(amount !== undefined ? { newAmountRupees: amount } : {}), ...(category ? { newCategory: category } : {}) };
    if (context.lastExpenseId) return { kind: 'tool', name: 'correct_entry', args: { entryId: context.lastExpenseId, ...changes, reason: note } };
    return { kind: 'reply', text: 'Which expense should I correct? Ask me to show today\'s expenses first, or record the expense again.' };
  }

  // 2. Weekly insights.
  if (/\b(weekly|week'?s?) (insights?|summary|report|review)\b|\bhow was (my|the|this) week\b/.test(text)) {
    return { kind: 'tool', name: 'weekly_insights', args: {} };
  }

  // 3. A day's summary: "today's summary", "what happened yesterday", "summary for 2026-10-14".
  if (/\b(summary|summarise|summarize|what happened|report)\b/.test(text)) {
    const iso = ISO_DATE.exec(text)?.[1];
    const date = iso ?? (period === 'yesterday' ? dateArg('yesterday', today).date : undefined);
    return { kind: 'tool', name: 'get_daily_summary', args: date ? { date } : {} };
  }

  // 4. Spending questions: "how much on feed this month", "total spent last month".
  if (/\b(how much|total|kitna|spent so far|spending on)\b/.test(text) && !/\b(paid|bought)\b/.test(text)) {
    return { kind: 'tool', name: 'get_expense_summary', args: { period: period ?? 'this_month', ...(category ? { category } : {}) } };
  }

  // 5. Lists: "show expenses this week", "list feed expenses".
  if (/\b(show|list|see|view)\b/.test(text) && /\b(expenses?|spending|payments?|entries)\b/.test(text)) {
    return { kind: 'tool', name: 'list_expenses', args: { period: period ?? 'this_month', ...(category ? { category } : {}), limit: 20 } };
  }

  // 6. Farm activities (no money involved).
  const activity = firstMatch(ACTIVITY_WORDS, text);
  if (activity && amount === undefined) {
    const animalOrField = findSubject(text, ACTIVITY_WORDS.find(([type]) => type === activity)![1]);
    return {
      kind: 'tool',
      name: 'record_farm_activity',
      args: { activityType: activity, ...(animalOrField ? { animalOrField } : {}), note, ...dateArg(text, today) },
    };
  }

  // 7. Expenses: "spent 2500 on feed", "paid ₹800 for medicine", "bought diesel 1200".
  if (amount !== undefined) {
    if (!category) return { kind: 'reply', text: `What was the ₹${amount} for? For example feed, fodder, medicine, labour, fuel, equipment or seed.` };
    return { kind: 'tool', name: 'record_expense', args: { amountRupees: amount, category, note, ...dateArg(text, today) } };
  }
  if (category && /\b(spent|paid|bought|purchased)\b/.test(text)) {
    return { kind: 'reply', text: `How much did you spend on ${category}?` };
  }

  return { kind: 'reply', text: FALLBACK_HELP };
}
