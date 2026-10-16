import { createHash } from 'node:crypto';
import { z } from 'zod';
import { EXPENSE_CATEGORIES, type ExpenseEntry } from '../domain/expense.js';
import type { LedgerRepository } from '../repositories/ledger-repository.js';
import type { RecordStore } from '../repositories/record-store.js';
import type { InsightNarrator } from '../services/insight-narrator.js';
import { formatPaise } from '../shared/money.js';
import { daysBetween, isValidIsoDate, NAMED_PERIODS, resolveNamedPeriod, type DateRange, type NamedPeriod } from '../shared/time.js';
import { ToolUserError } from './tool-errors.js';

export interface ToolDeps {
  ledger: LedgerRepository;
  /** Animals, milk, crops, harvests, insurance and reminders. */
  records: RecordStore;
  now: () => Date;
  /** Bedrock narration for weekly_insights. Without it the tool uses template narration. */
  narrator?: InsightNarrator | undefined;
}

export const entryDateInput = z.string().optional().describe('Date as YYYY-MM-DD in India time. Omit for today.');

export const clientRequestIdInput = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,64}$/, 'clientRequestId must be 8-64 letters, digits, "-" or "_"')
  .optional()
  .describe('Unique id for this request. Retrying with the same id never creates a second entry.');

/** Validates the date of a new entry: a real calendar date, not in the future. Omitted means today (India time). */
export function resolveEntryDate(date: string | undefined, today: string): string {
  const resolved = date ?? today;
  if (!isValidIsoDate(resolved)) throw new ToolUserError(`date "${resolved}" is not a real calendar date in YYYY-MM-DD format`);
  if (resolved > today) throw new ToolUserError(`date ${resolved} is in the future (today in India is ${today})`);
  return resolved;
}

/**
 * Builds idempotency info for a write. The fingerprint covers the request kind and the arguments *as sent*
 * (an omitted date stays omitted), so a retry after midnight still matches the original request.
 */
export function idempotencyFor(clientRequestId: string | undefined, kind: string, sentArgs: readonly unknown[]) {
  if (!clientRequestId) return undefined;
  return { clientRequestId, fingerprint: createHash('sha256').update(JSON.stringify([kind, ...sentArgs])).digest('hex') };
}

/** Longest range one request may cover. Keeps reads (and cost) bounded. */
export const MAX_RANGE_DAYS = 366;

/** Input fields shared by tools that read a date range. Either a named period or explicit from/to. */
export const dateRangeInput = {
  period: z
    .enum(NAMED_PERIODS)
    .optional()
    .describe('A named period in India time. Prefer this for words like "today" or "this month". Weeks start on Monday.'),
  from: z.string().optional().describe('Start date YYYY-MM-DD (inclusive). Use with "to" instead of "period".'),
  to: z.string().optional().describe('End date YYYY-MM-DD (inclusive). Defaults to today when only "from" is given.'),
};

/** Resolves period/from/to into a validated date range. Defaults to this month when nothing is given. */
export function resolveDateRange(
  args: { period?: NamedPeriod | undefined; from?: string | undefined; to?: string | undefined },
  today: string,
): DateRange & { label: string } {
  if (args.period && (args.from || args.to)) throw new ToolUserError('give either "period" or "from"/"to", not both');
  if (args.period || (!args.from && !args.to)) {
    const period = args.period ?? 'this_month';
    return { ...resolveNamedPeriod(period, today), label: period };
  }
  if (!args.from) throw new ToolUserError('"from" is required when "to" is given');
  const from = args.from;
  const to = args.to ?? today;
  for (const [name, value] of [['from', from], ['to', to]] as const) {
    if (!isValidIsoDate(value)) throw new ToolUserError(`${name} "${value}" is not a real calendar date in YYYY-MM-DD format`);
  }
  if (from > to) throw new ToolUserError(`from (${from}) is after to (${to})`);
  if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS) throw new ToolUserError(`a range can cover at most ${MAX_RANGE_DAYS} days`);
  return { from, to, label: 'custom' };
}

export const categoryFilterInput = z.enum(EXPENSE_CATEGORIES).optional().describe('Only include this expense category.');

export const entryViewSchema = z.object({
  entryId: z.string(),
  date: z.string(),
  category: z.enum(EXPENSE_CATEGORIES),
  amountPaise: z.number().int(),
  amountDisplay: z.string(),
  note: z.string().optional(),
});

/** The public shape of an expense in tool results. Money is integer paise plus a display string formatted by code. */
export function toEntryView(entry: ExpenseEntry): z.infer<typeof entryViewSchema> {
  return {
    entryId: entry.entryId,
    date: entry.date,
    category: entry.category,
    amountPaise: entry.amountPaise,
    amountDisplay: formatPaise(entry.amountPaise),
    ...(entry.note ? { note: entry.note } : {}),
  };
}

export const rangeOutputSchema = z.object({ from: z.string(), to: z.string(), label: z.string() });
