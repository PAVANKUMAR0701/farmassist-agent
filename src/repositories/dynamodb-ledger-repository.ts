import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { ulid } from 'ulid';
import { newActivityEntryId, type ActivityType, type FarmActivity, type NewActivity } from '../domain/activity.js';
import type { CorrectionRecord } from '../domain/correction.js';
import { parseEntryId } from '../domain/entry-id.js';
import { newExpenseEntryId, parseExpenseEntryId, type ExpenseCategory, type ExpenseEntry, type NewExpense } from '../domain/expense.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import {
  ConcurrentModificationError,
  EntryNotFoundError,
  IdempotencyConflictError,
  type CorrectExpenseInput,
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

/** Idempotency records expire after 7 days (DynamoDB TTL attribute `expiresAt`, epoch seconds). */
const IDEMPOTENCY_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Per-item cancellation codes of a failed transaction, or [] for any other error. */
function cancellationCodes(error: unknown): string[] {
  if (!(error instanceof TransactionCanceledException)) return [];
  return (error.CancellationReasons ?? []).map((reason) => reason.Code ?? 'None');
}

/**
 * Single-table layout (see docs/data-model.md):
 *   expense:      PK = FARM#<farmId>   SK = EXP#<date>#<ulid>
 *   activity:     PK = FARM#<farmId>   SK = ACT#<date>#<ulid>
 *   idempotency:  PK = FARM#<farmId>   SK = IDEM#<clientRequestId>   (points at the entry it created)
 *   correction:   PK = FARM#<farmId>   SK = CORR#<entryId>#<ulid>     (audit: before/after of one correction)
 * Date-ordered sort keys let one Query fetch a farm's entries for any date range.
 */
export const keys = {
  farm: (farmId: string) => `FARM#${farmId}`,
  expense: (date: string, id: string) => `EXP#${date}#${id}`,
  activity: (date: string, id: string) => `ACT#${date}#${id}`,
  idempotency: (clientRequestId: string) => `IDEM#${clientRequestId}`,
  correction: (entryId: string, id: string) => `CORR#${entryId}#${id}`,
  /** Inclusive SK bounds for a date range. "~" sorts after every ULID character. */
  range: (prefix: 'EXP' | 'ACT', from: string, to: string) => ({ lo: `${prefix}#${from}#`, hi: `${prefix}#${to}#~` }),
};

interface BaseItem {
  PK: string;
  SK: string;
  entryId: string;
  farmId: string;
  date: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

interface ExpenseItem extends BaseItem {
  type: 'EXPENSE';
  category: ExpenseCategory;
  amountPaise: number;
}

interface ActivityItem extends BaseItem {
  type: 'ACTIVITY';
  activityType: ActivityType;
  animalOrField?: string;
}

function toExpense(item: ExpenseItem): ExpenseEntry {
  return {
    entryId: item.entryId,
    farmId: item.farmId,
    date: item.date,
    category: item.category,
    amountPaise: item.amountPaise,
    ...(item.note ? { note: item.note } : {}),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    version: item.version,
  };
}

function toActivity(item: ActivityItem): FarmActivity {
  return {
    entryId: item.entryId,
    farmId: item.farmId,
    date: item.date,
    activityType: item.activityType,
    ...(item.animalOrField ? { animalOrField: item.animalOrField } : {}),
    ...(item.note ? { note: item.note } : {}),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    version: item.version,
  };
}

export class DynamoLedgerRepository implements LedgerRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async createExpense(input: NewExpense, idempotency?: Idempotency): Promise<CreateExpenseResult> {
    const timestamp = this.now();
    const entryId = newExpenseEntryId(input.date);
    const item: ExpenseItem = {
      PK: keys.farm(input.farmId),
      SK: keys.expense(input.date, parseEntryId(entryId)!.ulid),
      type: 'EXPENSE',
      entryId,
      farmId: input.farmId,
      date: input.date,
      category: input.category,
      amountPaise: input.amountPaise,
      ...(input.note ? { note: input.note } : {}),
      createdAt: timestamp.toISOString(),
      updatedAt: timestamp.toISOString(),
      version: 1,
    };
    return this.putWithIdempotency(item, timestamp, idempotency, toExpense);
  }

  async upsertExpense(entry: ExpenseEntry): Promise<void> {
    const parsed = parseExpenseEntryId(entry.entryId);
    if (!parsed || parsed.date !== entry.date) throw new Error(`Invalid expense id ${entry.entryId}`);
    const item: ExpenseItem = {
      PK: keys.farm(entry.farmId),
      SK: keys.expense(entry.date, parsed.ulid),
      type: 'EXPENSE',
      entryId: entry.entryId,
      farmId: entry.farmId,
      date: entry.date,
      category: entry.category,
      amountPaise: entry.amountPaise,
      ...(entry.note ? { note: entry.note } : {}),
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      version: entry.version,
    };
    await this.client.send(new PutCommand({ TableName: this.tableName, Item: item }));
  }

  async createActivity(input: NewActivity, idempotency?: Idempotency): Promise<CreateResult<FarmActivity>> {
    const timestamp = this.now();
    const entryId = newActivityEntryId(input.date);
    const item: ActivityItem = {
      PK: keys.farm(input.farmId),
      SK: keys.activity(input.date, parseEntryId(entryId)!.ulid),
      type: 'ACTIVITY',
      entryId,
      farmId: input.farmId,
      date: input.date,
      activityType: input.activityType,
      ...(input.animalOrField ? { animalOrField: input.animalOrField } : {}),
      ...(input.note ? { note: input.note } : {}),
      createdAt: timestamp.toISOString(),
      updatedAt: timestamp.toISOString(),
      version: 1,
    };
    return this.putWithIdempotency(item, timestamp, idempotency, toActivity);
  }

  async listExpenses(query: ExpenseRangeQuery & { limit: number; cursor?: string | undefined }): Promise<ExpensePage> {
    const start = query.cursor ? decodeCursor(query.cursor, query) : undefined;
    let exclusiveStartKey: Record<string, unknown> | undefined = start && {
      PK: keys.farm(query.farmId),
      SK: keys.expense(start.date, start.ulid),
    };

    // A category filter is applied after DynamoDB reads a page, so keep reading until we have limit + 1 matches
    // (the extra one tells us whether another page exists).
    const collected: ExpenseItem[] = [];
    do {
      const page = await this.client.send(
        new QueryCommand({
          ...this.expenseRangeQuery(query),
          ScanIndexForward: false,
          Limit: Math.max(query.limit + 1, 25),
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        }),
      );
      collected.push(...((page.Items ?? []) as ExpenseItem[]));
      exclusiveStartKey = page.LastEvaluatedKey;
    } while (collected.length <= query.limit && exclusiveStartKey);

    const items = collected.slice(0, query.limit).map(toExpense);
    const last = items.at(-1);
    const hasMore = collected.length > query.limit;
    return {
      items,
      ...(hasMore && last ? { nextCursor: encodeCursor({ date: last.date, ulid: parseEntryId(last.entryId)!.ulid }, query) } : {}),
    };
  }

  async getAllExpenses(query: ExpenseRangeQuery): Promise<ExpenseEntry[]> {
    return (await this.queryAll<ExpenseItem>(this.expenseRangeQuery(query))).map(toExpense);
  }

  async getExpense(farmId: string, entryId: string): Promise<ExpenseEntry | undefined> {
    const parsed = parseExpenseEntryId(entryId);
    if (!parsed) return undefined;
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: keys.farm(farmId), SK: keys.expense(parsed.date, parsed.ulid) },
        ConsistentRead: true,
      }),
    );
    return result.Item ? toExpense(result.Item as ExpenseItem) : undefined;
  }

  async correctExpense(input: CorrectExpenseInput): Promise<{ entry: ExpenseEntry; correction: CorrectionRecord }> {
    const parsed = parseExpenseEntryId(input.entryId);
    if (!parsed) throw new EntryNotFoundError(input.entryId);
    const key = { PK: keys.farm(input.farmId), SK: keys.expense(parsed.date, parsed.ulid) };
    const correctedAt = this.now().toISOString();
    const correction: CorrectionRecord = {
      correctionId: ulid(),
      farmId: input.farmId,
      entryId: input.entryId,
      before: input.before,
      after: input.after,
      changedFields: input.changedFields,
      ...(input.reason ? { reason: input.reason } : {}),
      correctedAt,
      fromVersion: input.expectedVersion,
      toVersion: input.expectedVersion + 1,
    };

    const set = ['#amountPaise = :amountPaise', '#category = :category', '#updatedAt = :updatedAt', '#version = :toVersion'];
    if (input.after.note) set.push('#note = :note');
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              // Optimistic locking: only update if nobody else changed the entry since we read it.
              Update: {
                TableName: this.tableName,
                Key: key,
                UpdateExpression: `SET ${set.join(', ')}${input.after.note ? '' : ' REMOVE #note'}`,
                ConditionExpression: 'attribute_exists(PK) AND #version = :fromVersion',
                ExpressionAttributeNames: {
                  '#amountPaise': 'amountPaise',
                  '#category': 'category',
                  '#note': 'note',
                  '#updatedAt': 'updatedAt',
                  '#version': 'version',
                },
                ExpressionAttributeValues: {
                  ':amountPaise': input.after.amountPaise,
                  ':category': input.after.category,
                  ':updatedAt': correctedAt,
                  ':fromVersion': input.expectedVersion,
                  ':toVersion': input.expectedVersion + 1,
                  ...(input.after.note ? { ':note': input.after.note } : {}),
                },
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: { PK: key.PK, SK: keys.correction(input.entryId, correction.correctionId), type: 'CORRECTION', ...correction },
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
          ],
        }),
      );
    } catch (error) {
      const codes = cancellationCodes(error);
      // Another transaction was writing this entry at the same moment: nothing of ours was saved.
      if (codes.includes('TransactionConflict')) throw new ConcurrentModificationError(input.entryId);
      if (codes[0] !== 'ConditionalCheckFailed') throw error;
      const current = await this.getExpense(input.farmId, input.entryId);
      throw current ? new ConcurrentModificationError(input.entryId) : new EntryNotFoundError(input.entryId);
    }

    const entry = await this.getExpense(input.farmId, input.entryId);
    if (!entry) throw new EntryNotFoundError(input.entryId);
    return { entry, correction };
  }

  async getCorrections(farmId: string, entryId: string): Promise<CorrectionRecord[]> {
    const items = await this.queryAll<CorrectionRecord & { PK?: string; SK?: string; type?: string }>({
      TableName: this.tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': keys.farm(farmId), ':prefix': `CORR#${entryId}#` },
    });
    return items.map(({ PK: _pk, SK: _sk, type: _type, ...record }) => record);
  }

  async getActivities(query: DateRangeQuery): Promise<FarmActivity[]> {
    const { lo, hi } = keys.range('ACT', query.from, query.to);
    const items = await this.queryAll<ActivityItem>({
      TableName: this.tableName,
      KeyConditionExpression: 'PK = :pk AND SK BETWEEN :lo AND :hi',
      ExpressionAttributeValues: { ':pk': keys.farm(query.farmId), ':lo': lo, ':hi': hi },
    });
    return items.map(toActivity);
  }

  /** Reads every page of a query, stopping with TooManyEntriesError past the safety cap. */
  private async queryAll<T>(input: QueryCommandInput): Promise<T[]> {
    const items: T[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await this.client.send(new QueryCommand({ ...input, ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}) }));
      items.push(...((page.Items ?? []) as T[]));
      if (items.length > MAX_SUMMARY_ENTRIES) throw new TooManyEntriesError();
      exclusiveStartKey = page.LastEvaluatedKey;
    } while (exclusiveStartKey);
    return items;
  }

  private expenseRangeQuery(query: ExpenseRangeQuery): QueryCommandInput {
    const { lo, hi } = keys.range('EXP', query.from, query.to);
    return {
      TableName: this.tableName,
      KeyConditionExpression: 'PK = :pk AND SK BETWEEN :lo AND :hi',
      ...(query.category ? { FilterExpression: '#category = :category', ExpressionAttributeNames: { '#category': 'category' } } : {}),
      ExpressionAttributeValues: {
        ':pk': keys.farm(query.farmId),
        ':lo': lo,
        ':hi': hi,
        ...(query.category ? { ':category': query.category } : {}),
      },
    };
  }

  /**
   * Writes a new entry. With idempotency, the entry and its IDEM# marker are written in one transaction:
   * either both exist or neither does. A retry with the same id + fingerprint returns the original entry.
   */
  private async putWithIdempotency<I extends BaseItem, E>(
    item: I,
    timestamp: Date,
    idempotency: Idempotency | undefined,
    toEntry: (item: I) => E,
  ): Promise<CreateResult<E>> {
    const putEntry = { TableName: this.tableName, Item: item, ConditionExpression: 'attribute_not_exists(PK)' };
    if (!idempotency) {
      await this.client.send(new PutCommand(putEntry));
      return { entry: toEntry(item), duplicate: false };
    }

    /** Set when this write raced another request for the same marker (see below). */
    let raceError: unknown;
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  PK: item.PK,
                  SK: keys.idempotency(idempotency.clientRequestId),
                  type: 'IDEMPOTENCY',
                  entryId: item.entryId,
                  entrySK: item.SK,
                  fingerprint: idempotency.fingerprint,
                  createdAt: item.createdAt,
                  expiresAt: Math.floor(timestamp.getTime() / 1000) + IDEMPOTENCY_TTL_SECONDS,
                },
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            { Put: putEntry },
          ],
        }),
      );
      return { entry: toEntry(item), duplicate: false };
    } catch (error) {
      const code = cancellationCodes(error)[0];
      // TransactionConflict: a retry raced the original request for the same marker. If the original has
      // committed, replay it; otherwise rethrow (this request wrote nothing, so the caller can safely retry).
      if (code === 'TransactionConflict') raceError = error;
      else if (code !== 'ConditionalCheckFailed') throw error;
    }

    // A previous request already used this clientRequestId: return its entry instead of writing a duplicate.
    const marker = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: item.PK, SK: keys.idempotency(idempotency.clientRequestId) },
        ConsistentRead: true,
      }),
    );
    if (!marker.Item) {
      if (raceError) throw raceError;
      throw new Error('Idempotency marker vanished between write and read');
    }
    if (marker.Item.fingerprint !== idempotency.fingerprint) throw new IdempotencyConflictError(idempotency.clientRequestId);

    const original = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: { PK: item.PK, SK: marker.Item.entrySK }, ConsistentRead: true }),
    );
    if (!original.Item) throw new Error('Entry referenced by idempotency marker not found');
    return { entry: toEntry(original.Item as I), duplicate: true };
  }
}
