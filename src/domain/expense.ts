import { ulid } from 'ulid';

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

const ENTRY_ID_PATTERN = /^exp_(\d{4})(\d{2})(\d{2})_([0-9A-HJKMNP-TV-Z]{26})$/;

/** Creates a new entry id. ULIDs sort by creation time, so entries on the same day stay in recording order. */
export function newExpenseEntryId(date: string): string {
  return `exp_${date.replaceAll('-', '')}_${ulid()}`;
}

/** Splits an entry id back into its date and ULID, or returns undefined if the id is malformed. */
export function parseExpenseEntryId(entryId: string): { date: string; ulid: string } | undefined {
  const match = ENTRY_ID_PATTERN.exec(entryId);
  if (!match) return undefined;
  const [, year, month, day, id] = match;
  return { date: `${year}-${month}-${day}`, ulid: id! };
}
