import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { newExpenseEntryId, parseExpenseEntryId, type ExpenseCategory, type ExpenseEntry, type NewExpense } from '../domain/expense.js';
import { IdempotencyConflictError, type CreateExpenseResult, type LedgerRepository } from './ledger-repository.js';

/** Idempotency records expire after 7 days (DynamoDB TTL attribute `expiresAt`, epoch seconds). */
const IDEMPOTENCY_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Single-table layout:
 *   expense:      PK = FARM#<farmId>   SK = EXP#<date>#<ulid>
 *   idempotency:  PK = FARM#<farmId>   SK = IDEM#<clientRequestId>   (points at the expense it created)
 * Date-ordered sort keys let one Query fetch a farm's expenses for any date range.
 */
export const keys = {
  farm: (farmId: string) => `FARM#${farmId}`,
  expense: (date: string, id: string) => `EXP#${date}#${id}`,
  idempotency: (clientRequestId: string) => `IDEM#${clientRequestId}`,
};

interface ExpenseItem {
  PK: string;
  SK: string;
  type: 'EXPENSE';
  entryId: string;
  farmId: string;
  date: string;
  category: ExpenseCategory;
  amountPaise: number;
  note?: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

function toEntry(item: ExpenseItem): ExpenseEntry {
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

export class DynamoLedgerRepository implements LedgerRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async createExpense(
    input: NewExpense,
    idempotency?: { clientRequestId: string; fingerprint: string },
  ): Promise<CreateExpenseResult> {
    const timestamp = this.now();
    const entryId = newExpenseEntryId(input.date);
    const { ulid } = parseExpenseEntryId(entryId)!;
    const item: ExpenseItem = {
      PK: keys.farm(input.farmId),
      SK: keys.expense(input.date, ulid),
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

    if (!idempotency) {
      await this.client.send(
        new PutCommand({ TableName: this.tableName, Item: item, ConditionExpression: 'attribute_not_exists(PK)' }),
      );
      return { entry: toEntry(item), duplicate: false };
    }

    // Write the expense and its idempotency marker atomically: either both exist or neither does.
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
                  entryId,
                  expenseSK: item.SK,
                  fingerprint: idempotency.fingerprint,
                  createdAt: item.createdAt,
                  expiresAt: Math.floor(timestamp.getTime() / 1000) + IDEMPOTENCY_TTL_SECONDS,
                },
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            { Put: { TableName: this.tableName, Item: item, ConditionExpression: 'attribute_not_exists(PK)' } },
          ],
        }),
      );
      return { entry: toEntry(item), duplicate: false };
    } catch (error) {
      const markerAlreadyExists =
        error instanceof TransactionCanceledException && error.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed';
      if (!markerAlreadyExists) throw error;
      return this.replayIdempotentCreate(input.farmId, idempotency);
    }
  }

  /** A previous request already used this clientRequestId: return its entry instead of writing a duplicate. */
  private async replayIdempotentCreate(
    farmId: string,
    idempotency: { clientRequestId: string; fingerprint: string },
  ): Promise<CreateExpenseResult> {
    const marker = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: keys.farm(farmId), SK: keys.idempotency(idempotency.clientRequestId) },
        ConsistentRead: true,
      }),
    );
    if (!marker.Item) throw new Error('Idempotency marker vanished between write and read');
    if (marker.Item.fingerprint !== idempotency.fingerprint) throw new IdempotencyConflictError(idempotency.clientRequestId);

    const original = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: { PK: keys.farm(farmId), SK: marker.Item.expenseSK }, ConsistentRead: true }),
    );
    if (!original.Item) throw new Error('Expense referenced by idempotency marker not found');
    return { entry: toEntry(original.Item as ExpenseItem), duplicate: true };
  }
}
