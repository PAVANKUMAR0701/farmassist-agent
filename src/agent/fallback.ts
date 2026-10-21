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
const QUANTITY = /\d[\d,.]*\s*(?:quintals?|qtls?|kgs?|kilos?|kilograms?|grams?|litres?|liters?|ltrs?|acres?|guntha|tonnes?|tons?)\b/;
const MONEY = /₹|\brs\b|\brupees?\b|\binr\b|\brupaye\b/;
export const BASIC_MODE_RECORDS =
  'In basic mode I can record expenses and activities only. Recording milk, crops and the herd needs the AI assistant, which is not answering right now. Please try again in a moment.';

/**
 * A request for information, not something to record: "give me the list of…", "show…", "how much…", or a
 * trailing "?". Without this, "give me today's milk" was read back as "Shall I record milking?" (seen 2026-10-21).
 */
const QUESTION = /^(give|show|list|tell|what|which|who|how|get|display|see|view|check|can you (give|show|tell))\b|\b(list of|how much|how many|kitna|kitne)\b|\?\s*$/;
/** A rate in rupees: the number next to ₹ / rs / rupees ("18 litres at ₹36.5" -> 36.5, not 18). */
const RATE = /(?:₹|\brs\.?)\s*(\d+(?:\.\d{1,2})?)|(\d+(?:\.\d{1,2})?)\s*(?:rupees?|rs\b)/;
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

/** "vaccinated the brown cow today" -> "brown cow". Works on the farmer's own text, so names keep their capitals. */
function findSubject(text: string, verbPattern: RegExp): string | undefined {
  const match = new RegExp(verbPattern.source, 'i').exec(text);
  if (!match) return undefined;
  const subject = text
    .slice(match.index + match[0].length)
    .replace(/\b(today|yesterday|this morning|this evening|in the morning|in the evening)\b.*$/i, '')
    .replace(ISO_DATE, '')
    .split(/[,.;]| with | for | on | at /i)[0]!
    .replace(/^\s*(the|my|our|of|for)\s+/i, '')
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

  // "30 quintal of paddy", "8 litres of milk": quantities, not money. Basic mode cannot record those, and must
  // never mistake them for an expense amount (seen live: "What was the ₹30 for?").
  if (QUANTITY.test(text) && !MONEY.test(text)) return { kind: 'reply', text: BASIC_MODE_RECORDS };

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
  if (/\b(how much|total|kitna|spent so far|spending on)\b/.test(text) && !/\b(paid|bought|milk)\b/.test(text)) {
    return { kind: 'tool', name: 'get_expense_summary', args: { period: period ?? 'this_month', ...(category ? { category } : {}) } };
  }

  // 5. Lists: "show expenses this week", "list feed expenses".
  if (/\b(show|list|see|view)\b/.test(text) && /\b(expenses?|spending|payments?|entries)\b/.test(text)) {
    return { kind: 'tool', name: 'list_expenses', args: { period: period ?? 'this_month', ...(category ? { category } : {}), limit: 20 } };
  }

  // 6a. Money value of milk at the farmer's rate: worked out by the server (get_milk_value), never here.
  if (/\bmilk\b/.test(text) && /\b(rupees?|rs|amount|value|worth|price|rate|income|earn(ed|ing)?|calculate)\b|₹/.test(text)) {
    const rate = RATE.exec(text.replace(ISO_DATE, ' '));
    const value = rate ? Number(rate[1] ?? rate[2]) : undefined;
    if (value && value > 0 && value <= 1000) return { kind: 'tool', name: 'get_milk_value', args: { period: period ?? 'today', ratePerLitreRupees: value } };
    if (QUESTION.test(text) || /\b(calculate|amount|value|worth)\b/.test(text)) {
      return { kind: 'reply', text: 'At what price per litre? For example: "today\'s milk at 36.5 rupees a litre".' };
    }
  }

  // 6. Questions about milk, the herd, crops and what is due: read-only lookups, never a write.
  if (QUESTION.test(text)) {
    if (/\bmilk\b/.test(text)) return { kind: 'tool', name: 'get_milk_summary', args: { period: period ?? 'today', groupBy: 'animal' } };
    if (/\b(remind(ers?)?|due|coming up|tasks?|insurance)\b/.test(text)) return { kind: 'tool', name: 'list_reminders', args: { daysAhead: 30 } };
    if (/\bcrops?\b|\b(paddy|ragi|sugarcane|fields?)\b/.test(text)) return { kind: 'tool', name: 'list_crops', args: {} };
    if (/\b(cows?|animals?|herd|cattle|buffalo(es)?|calf|calves|goats?|sheep)\b/.test(text)) return { kind: 'tool', name: 'list_animals', args: {} };
  }

  // 7. Farm activities (no money involved). A question is never recorded as an activity.
  const activity = firstMatch(ACTIVITY_WORDS, text);
  if (activity && amount === undefined && !QUESTION.test(text)) {
    const animalOrField = findSubject(original.replace(/\s+/g, ' '), ACTIVITY_WORDS.find(([type]) => type === activity)![1]);
    return {
      kind: 'tool',
      name: 'record_farm_activity',
      args: { activityType: activity, ...(animalOrField ? { animalOrField } : {}), note, ...dateArg(text, today) },
    };
  }

  // 8. Expenses: "spent 2500 on feed", "paid ₹800 for medicine", "bought diesel 1200".
  if (amount !== undefined) {
    if (!category) return { kind: 'reply', text: `What was the ₹${amount} for? For example feed, fodder, medicine, labour, fuel, equipment or seed.` };
    return { kind: 'tool', name: 'record_expense', args: { amountRupees: amount, category, note, ...dateArg(text, today) } };
  }
  if (category && /\b(spent|paid|bought|purchased)\b/.test(text)) {
    return { kind: 'reply', text: `How much did you spend on ${category}?` };
  }

  return { kind: 'reply', text: FALLBACK_HELP };
}
