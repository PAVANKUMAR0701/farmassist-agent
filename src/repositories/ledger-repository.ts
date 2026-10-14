import type { ExpenseCategory, ExpenseEntry, NewExpense } from '../domain/expense.js';

export interface CreateExpenseResult {
  entry: ExpenseEntry;
  /** True when this call replayed an earlier request with the same clientRequestId; nothing new was written. */
  duplicate: boolean;
}

export interface ExpenseRangeQuery {
  farmId: string;
  /** Inclusive YYYY-MM-DD bounds (farm time). */
  from: string;
  to: string;
  category?: ExpenseCategory | undefined;
}

export interface ExpensePage {
  /** Newest first (by date, then by recording time). */
  items: ExpenseEntry[];
  nextCursor?: string;
}

/** Safety cap on how many entries one summary may read. A small farm records far fewer in a year. */
export const MAX_SUMMARY_ENTRIES = 10_000;

/** Persistence port for the farm ledger. Implemented by DynamoDB in AWS and in memory for local runs and tests. */
export interface LedgerRepository {
  createExpense(input: NewExpense, idempotency?: { clientRequestId: string; fingerprint: string }): Promise<CreateExpenseResult>;
  /** One page of expenses in a date range. Throws InvalidCursorError for a tampered or mismatched cursor. */
  listExpenses(query: ExpenseRangeQuery & { limit: number; cursor?: string | undefined }): Promise<ExpensePage>;
  /** Every expense in a date range (for summaries). Throws TooManyEntriesError above MAX_SUMMARY_ENTRIES. */
  getAllExpenses(query: ExpenseRangeQuery): Promise<ExpenseEntry[]>;
}

/** The same clientRequestId was reused for a request with different details. */
export class IdempotencyConflictError extends Error {
  constructor(clientRequestId: string) {
    super(`clientRequestId "${clientRequestId}" was already used for a different expense`);
    this.name = 'IdempotencyConflictError';
  }
}

export class TooManyEntriesError extends Error {
  constructor() {
    super(`more than ${MAX_SUMMARY_ENTRIES} entries in this range; choose a shorter period`);
    this.name = 'TooManyEntriesError';
  }
}
