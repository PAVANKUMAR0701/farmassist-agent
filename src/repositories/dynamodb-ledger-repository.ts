import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { newActivityEntryId, type ActivityType, type FarmActivity, type NewActivity } from '../domain/activity.js';
import { parseEntryId } from '../domain/entry-id.js';
import { newExpenseEntryId, type ExpenseCategory, type ExpenseEntry, type NewExpense } from '../domain/expense.js';
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

/** Idempotency records expire after 7 days (DynamoDB TTL attribute `expiresAt`, epoch seconds). */
const IDEMPOTENCY_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Single-table layout (see docs/data-model.md):
 *   expense:      PK = FARM#<farmId>   SK = EXP#<date>#<ulid>
 *   activity:     PK = FARM#<farmId>   SK = ACT#<date>#<ulid>
 *   idempotency:  PK = FARM#<farmId>   SK = IDEM#<clientRequestId>   (points at the entry it created)
 * Date-ordered sort keys let one Query fetch a farm's entries for any date range.
 */
export const keys = {
  farm: (farmId: string) => `FARM#${farmId}`,
  expense: (date: string, id: string) => `EXP#${date}#${id}`,
  activity: (date: string, id: string) => `ACT#${date}#${id}`,
  idempotency: (clientRequestId: string) => `IDEM#${clientRequestId}`,
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
      const markerAlreadyExists =
        error instanceof TransactionCanceledException && error.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed';
      if (!markerAlreadyExists) throw error;
    }

    // A previous request already used this clientRequestId: return its entry instead of writing a duplicate.
    const marker = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: item.PK, SK: keys.idempotency(idempotency.clientRequestId) },
        ConsistentRead: true,
      }),
    );
    if (!marker.Item) throw new Error('Idempotency marker vanished between write and read');
    if (marker.Item.fingerprint !== idempotency.fingerprint) throw new IdempotencyConflictError(idempotency.clientRequestId);

    const original = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: { PK: item.PK, SK: marker.Item.entrySK }, ConsistentRead: true }),
    );
    if (!original.Item) throw new Error('Entry referenced by idempotency marker not found');
    return { entry: toEntry(original.Item as I), duplicate: true };
  }
}
