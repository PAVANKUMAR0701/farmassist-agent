import { newExpenseEntryId, type ExpenseEntry, type NewExpense } from '../domain/expense.js';
import { IdempotencyConflictError, type CreateExpenseResult, type LedgerRepository } from './ledger-repository.js';

/**
 * In-memory ledger for unit tests and keyless local development. Data is lost on restart.
 * Mirrors the DynamoDB implementation's behaviour, including idempotency.
 */
export class InMemoryLedgerRepository implements LedgerRepository {
  readonly expenses = new Map<string, ExpenseEntry>();
  private readonly idempotency = new Map<string, { entryId: string; fingerprint: string }>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async createExpense(
    input: NewExpense,
    idempotency?: { clientRequestId: string; fingerprint: string },
  ): Promise<CreateExpenseResult> {
    const idemKey = idempotency && `${input.farmId}|${idempotency.clientRequestId}`;
    if (idemKey) {
      const previous = this.idempotency.get(idemKey);
      if (previous) {
        if (previous.fingerprint !== idempotency.fingerprint) throw new IdempotencyConflictError(idempotency.clientRequestId);
        return { entry: structuredClone(this.expenses.get(previous.entryId)!), duplicate: true };
      }
    }

    const timestamp = this.now().toISOString();
    const entry: ExpenseEntry = {
      entryId: newExpenseEntryId(input.date),
      farmId: input.farmId,
      date: input.date,
      category: input.category,
      amountPaise: input.amountPaise,
      ...(input.note ? { note: input.note } : {}),
      createdAt: timestamp,
      updatedAt: timestamp,
      version: 1,
    };
    this.expenses.set(entry.entryId, entry);
    if (idemKey) this.idempotency.set(idemKey, { entryId: entry.entryId, fingerprint: idempotency.fingerprint });
    return { entry: structuredClone(entry), duplicate: false };
  }
}
