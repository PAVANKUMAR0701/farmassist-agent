import { newActivityEntryId, type FarmActivity, type NewActivity } from '../domain/activity.js';
import { parseEntryId } from '../domain/entry-id.js';
import { newExpenseEntryId, type ExpenseEntry, type NewExpense } from '../domain/expense.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import {
  IdempotencyConflictError,
  MAX_SUMMARY_ENTRIES,
  TooManyEntriesError,
  type CreateExpenseResult,
  type CreateResult,
  type DateRangeQuery,
  type ExpensePage,
  type ExpenseRangeQuery,
  type Idempotency,
  type LedgerRepository,
} from './ledger-repository.js';

/** Sort key "date#ulid" — the same order as the DynamoDB sort key. */
const position = (entry: { date: string; entryId: string }) => `${entry.date}#${parseEntryId(entry.entryId)!.ulid}`;

/**
 * In-memory ledger for unit tests and keyless local development. Data is lost on restart.
 * Mirrors the DynamoDB implementation's behaviour, including idempotency and pagination.
 */
export class InMemoryLedgerRepository implements LedgerRepository {
  readonly expenses = new Map<string, ExpenseEntry>();
  readonly activities = new Map<string, FarmActivity>();
  private readonly idempotency = new Map<string, { entryId: string; fingerprint: string }>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async createExpense(input: NewExpense, idempotency?: Idempotency): Promise<CreateExpenseResult> {
    return this.createWithIdempotency(this.expenses, input.farmId, idempotency, (timestamp) => ({
      entryId: newExpenseEntryId(input.date),
      farmId: input.farmId,
      date: input.date,
      category: input.category,
      amountPaise: input.amountPaise,
      ...(input.note ? { note: input.note } : {}),
      createdAt: timestamp,
      updatedAt: timestamp,
      version: 1,
    }));
  }

  async createActivity(input: NewActivity, idempotency?: Idempotency): Promise<CreateResult<FarmActivity>> {
    return this.createWithIdempotency(this.activities, input.farmId, idempotency, (timestamp) => ({
      entryId: newActivityEntryId(input.date),
      farmId: input.farmId,
      date: input.date,
      activityType: input.activityType,
      ...(input.animalOrField ? { animalOrField: input.animalOrField } : {}),
      ...(input.note ? { note: input.note } : {}),
      createdAt: timestamp,
      updatedAt: timestamp,
      version: 1,
    }));
  }

  async listExpenses(query: ExpenseRangeQuery & { limit: number; cursor?: string | undefined }): Promise<ExpensePage> {
    const start = query.cursor ? decodeCursor(query.cursor, query) : undefined;
    const startKey = start && `${start.date}#${start.ulid}`;
    const matching = this.matchingExpenses(query)
      .sort((a, b) => position(b).localeCompare(position(a)))
      .filter((e) => !startKey || position(e) < startKey);

    const items = matching.slice(0, query.limit);
    const last = items.at(-1);
    const hasMore = matching.length > query.limit;
    return {
      items: items.map((e) => structuredClone(e)),
      ...(hasMore && last ? { nextCursor: encodeCursor({ date: last.date, ulid: parseEntryId(last.entryId)!.ulid }, query) } : {}),
    };
  }

  async getAllExpenses(query: ExpenseRangeQuery): Promise<ExpenseEntry[]> {
    const items = this.matchingExpenses(query);
    if (items.length > MAX_SUMMARY_ENTRIES) throw new TooManyEntriesError();
    return items.map((e) => structuredClone(e));
  }

  async getActivities(query: DateRangeQuery): Promise<FarmActivity[]> {
    const items = [...this.activities.values()]
      .filter((a) => a.farmId === query.farmId && a.date >= query.from && a.date <= query.to)
      .sort((a, b) => position(a).localeCompare(position(b)));
    if (items.length > MAX_SUMMARY_ENTRIES) throw new TooManyEntriesError();
    return items.map((a) => structuredClone(a));
  }

  private async createWithIdempotency<T extends { entryId: string }>(
    store: Map<string, T>,
    farmId: string,
    idempotency: Idempotency | undefined,
    build: (timestamp: string) => T,
  ): Promise<CreateResult<T>> {
    const idemKey = idempotency && `${farmId}|${idempotency.clientRequestId}`;
    if (idemKey) {
      const previous = this.idempotency.get(idemKey);
      if (previous) {
        const original = store.get(previous.entryId);
        if (previous.fingerprint !== idempotency.fingerprint || !original) throw new IdempotencyConflictError(idempotency.clientRequestId);
        return { entry: structuredClone(original), duplicate: true };
      }
    }
    const entry = build(this.now().toISOString());
    store.set(entry.entryId, entry);
    if (idemKey) this.idempotency.set(idemKey, { entryId: entry.entryId, fingerprint: idempotency.fingerprint });
    return { entry: structuredClone(entry), duplicate: false };
  }

  private matchingExpenses(query: ExpenseRangeQuery): ExpenseEntry[] {
    return [...this.expenses.values()].filter(
      (e) =>
        e.farmId === query.farmId &&
        e.date >= query.from &&
        e.date <= query.to &&
        (query.category === undefined || e.category === query.category),
    );
  }
}
