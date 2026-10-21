import type { FarmActivity, NewActivity } from '../domain/activity.js';
import type { CorrectableField, CorrectionRecord, ExpenseSnapshot } from '../domain/correction.js';
import type { ExpenseCategory, ExpenseEntry, NewExpense } from '../domain/expense.js';

/** Optional duplicate protection: the same clientRequestId + fingerprint returns the original entry instead of writing again. */
export interface Idempotency {
  clientRequestId: string;
  /** Hash of the request as sent, including its kind, so an id reused for a different request is detected. */
  fingerprint: string;
}

export interface CreateResult<T> {
  entry: T;
  /** True when this call replayed an earlier request with the same clientRequestId; nothing new was written. */
  duplicate: boolean;
}

export type CreateExpenseResult = CreateResult<ExpenseEntry>;

export interface ExpenseRangeQuery {
  farmId: string;
  /** Inclusive YYYY-MM-DD bounds (farm time). */
  from: string;
  to: string;
  category?: ExpenseCategory | undefined;
}

export interface DateRangeQuery {
  farmId: string;
  from: string;
  to: string;
}

export interface ExpensePage {
  /** Newest first (by date, then by recording time). */
  items: ExpenseEntry[];
  nextCursor?: string;
}

/** Safety cap on how many entries one read may return. A small farm records far fewer in a year. */
export const MAX_SUMMARY_ENTRIES = 10_000;

/** Persistence port for the farm ledger. Implemented by DynamoDB in AWS and in memory for local runs and tests. */
export interface LedgerRepository {
  createExpense(input: NewExpense, idempotency?: Idempotency): Promise<CreateExpenseResult>;
  /** One page of expenses in a date range. Throws InvalidCursorError for a tampered or mismatched cursor. */
  listExpenses(query: ExpenseRangeQuery & { limit: number; cursor?: string | undefined }): Promise<ExpensePage>;
  /** Every expense in a date range (for summaries). Throws TooManyEntriesError above MAX_SUMMARY_ENTRIES. */
  getAllExpenses(query: ExpenseRangeQuery): Promise<ExpenseEntry[]>;

  /** Strongly consistent read of one expense, or undefined if it does not exist for this farm. */
  getExpense(farmId: string, entryId: string): Promise<ExpenseEntry | undefined>;
  /**
   * Updates an expense and writes its audit record atomically, only if the stored version still equals
   * expectedVersion. Throws EntryNotFoundError or ConcurrentModificationError otherwise.
   */
  correctExpense(input: CorrectExpenseInput): Promise<{ entry: ExpenseEntry; correction: CorrectionRecord }>;
  /**
   * Writes an expense with a known id, replacing whatever is stored under it. Only for importing seed data with
   * stable ids, so re-running the import never adds a second copy.
   */
  upsertExpense(entry: ExpenseEntry): Promise<void>;
  /** Audit trail for one expense, oldest first. */
  getCorrections(farmId: string, entryId: string): Promise<CorrectionRecord[]>;

  createActivity(input: NewActivity, idempotency?: Idempotency): Promise<CreateResult<FarmActivity>>;
  /** Every activity in a date range, oldest first. Throws TooManyEntriesError above MAX_SUMMARY_ENTRIES. */
  getActivities(query: DateRangeQuery): Promise<FarmActivity[]>;
}

export interface CorrectExpenseInput {
  farmId: string;
  entryId: string;
  expectedVersion: number;
  before: ExpenseSnapshot;
  after: ExpenseSnapshot;
  changedFields: CorrectableField[];
  reason?: string | undefined;
}

export class EntryNotFoundError extends Error {
  constructor(entryId: string) {
    super(`no entry with id ${entryId} was found for this farm`);
    this.name = 'EntryNotFoundError';
  }
}

/** The entry changed between reading it and saving the correction. */
export class ConcurrentModificationError extends Error {
  constructor(entryId: string) {
    super(`entry ${entryId} was changed by another request at the same time; nothing was saved, please check it and try again`);
    this.name = 'ConcurrentModificationError';
  }
}

/** The same clientRequestId was reused for a request with different details. */
export class IdempotencyConflictError extends Error {
  constructor(clientRequestId: string) {
    super(`clientRequestId "${clientRequestId}" was already used for a different request`);
    this.name = 'IdempotencyConflictError';
  }
}

export class TooManyEntriesError extends Error {
  constructor() {
    super(`more than ${MAX_SUMMARY_ENTRIES} entries in this range; choose a shorter period`);
    this.name = 'TooManyEntriesError';
  }
}
