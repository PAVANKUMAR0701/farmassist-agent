import { newEntryId, parseEntryId } from './entry-id.js';

export const EXPENSE_CATEGORIES = ['feed', 'fodder', 'medicine', 'labour', 'fuel', 'equipment', 'seed', 'other'] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export interface ExpenseEntry {
  /** Public, opaque id such as exp_20261014_01JABCDEF... The date part lets us find the item without a scan. */
  entryId: string;
  farmId: string;
  /** Farm-local calendar date (Asia/Kolkata), YYYY-MM-DD. */
  date: string;
  category: ExpenseCategory;
  amountPaise: number;
  note?: string;
  createdAt: string;
  updatedAt: string;
  /** Starts at 1 and increases with each correction (used for optimistic locking). */
  version: number;
}

export interface NewExpense {
  farmId: string;
  date: string;
  category: ExpenseCategory;
  amountPaise: number;
  note?: string;
}

export function newExpenseEntryId(date: string): string {
  return newEntryId('expense', date);
}

/** Splits an expense id back into its date and ULID, or returns undefined if it is malformed or not an expense id. */
export function parseExpenseEntryId(entryId: string): { date: string; ulid: string } | undefined {
  const parsed = parseEntryId(entryId);
  return parsed?.kind === 'expense' ? { date: parsed.date, ulid: parsed.ulid } : undefined;
}
