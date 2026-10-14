import { newExpenseEntryId, parseExpenseEntryId, type ExpenseEntry, type NewExpense } from '../domain/expense.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import {
  IdempotencyConflictError,
  MAX_SUMMARY_ENTRIES,
  TooManyEntriesError,
  type CreateExpenseResult,
  type ExpensePage,
  type ExpenseRangeQuery,
  type LedgerRepository,
} from './ledger-repository.js';

/** Sort key "date#ulid" — the same order as the DynamoDB sort key. */
const position = (entry: ExpenseEntry) => `${entry.date}#${parseExpenseEntryId(entry.entryId)!.ulid}`;

/**
 * In-memory ledger for unit tests and keyless local development. Data is lost on restart.
 * Mirrors the DynamoDB implementation's behaviour, including idempotency and pagination.
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

  async listExpenses(query: ExpenseRangeQuery & { limit: number; cursor?: string | undefined }): Promise<ExpensePage> {
    const start = query.cursor ? decodeCursor(query.cursor, query) : undefined;
    const startKey = start && `${start.date}#${start.ulid}`;
    const matching = this.matching(query)
      .sort((a, b) => position(b).localeCompare(position(a)))
      .filter((e) => !startKey || position(e) < startKey);

    const items = matching.slice(0, query.limit);
    const last = items.at(-1);
    const hasMore = matching.length > query.limit;
    return {
      items: items.map((e) => structuredClone(e)),
      ...(hasMore && last ? { nextCursor: encodeCursor(parseCursorPosition(last), query) } : {}),
    };
  }

  async getAllExpenses(query: ExpenseRangeQuery): Promise<ExpenseEntry[]> {
    const items = this.matching(query);
    if (items.length > MAX_SUMMARY_ENTRIES) throw new TooManyEntriesError();
    return items.map((e) => structuredClone(e));
  }

  private matching(query: ExpenseRangeQuery): ExpenseEntry[] {
    return [...this.expenses.values()].filter(
      (e) =>
        e.farmId === query.farmId &&
        e.date >= query.from &&
        e.date <= query.to &&
        (query.category === undefined || e.category === query.category),
    );
  }
}

function parseCursorPosition(entry: ExpenseEntry) {
  return { date: entry.date, ulid: parseExpenseEntryId(entry.entryId)!.ulid };
}
