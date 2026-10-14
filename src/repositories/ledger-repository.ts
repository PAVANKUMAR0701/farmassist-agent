import type { ExpenseEntry, NewExpense } from '../domain/expense.js';

export interface CreateExpenseResult {
  entry: ExpenseEntry;
  /** True when this call replayed an earlier request with the same clientRequestId; nothing new was written. */
  duplicate: boolean;
}

/** Persistence port for the farm ledger. Implemented by DynamoDB in AWS and in memory for local runs and tests. */
export interface LedgerRepository {
  createExpense(input: NewExpense, idempotency?: { clientRequestId: string; fingerprint: string }): Promise<CreateExpenseResult>;
}

/** The same clientRequestId was reused for a request with different details. */
export class IdempotencyConflictError extends Error {
  constructor(clientRequestId: string) {
    super(`clientRequestId "${clientRequestId}" was already used for a different expense`);
    this.name = 'IdempotencyConflictError';
  }
}
