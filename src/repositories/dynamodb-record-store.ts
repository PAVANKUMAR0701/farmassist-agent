import { ConditionalCheckFailedException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ConcurrentModificationError, EntryNotFoundError, IdempotencyConflictError, MAX_SUMMARY_ENTRIES, TooManyEntriesError, type Idempotency } from './ledger-repository.js';
import { parseRecordId, sortKeyRange, type FarmRecord, type RecordKind, type RecordQuery, type RecordStore } from './record-store.js';

const IDEMPOTENCY_TTL_SECONDS = 7 * 24 * 60 * 60;

interface RecordItem {
  PK: string;
  SK: string;
  type: 'RECORD';
  kind: RecordKind;
  entryId: string;
  farmId: string;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  version: number;
}

const toRecord = <T>(item: RecordItem): FarmRecord<T> => ({
  id: item.entryId,
  kind: item.kind,
  farmId: item.farmId,
  data: item.data as T,
  createdAt: item.createdAt,
  updatedAt: item.updatedAt,
  version: item.version,
});

/** DynamoDB implementation in the ledger's single table (key layout in record-store.ts). */
export class DynamoRecordStore implements RecordStore {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create<T extends Record<string, unknown>>(farmId: string, id: string, data: T, idempotency?: Idempotency) {
    const parsed = parseRecordId(id);
    if (!parsed) throw new Error(`Invalid record id ${id}`);
    const timestamp = this.now();
    const item: RecordItem = {
      PK: `FARM#${farmId}`,
      SK: parsed.sortKey,
      type: 'RECORD',
      kind: parsed.kind,
      entryId: id,
      farmId,
      data,
      createdAt: timestamp.toISOString(),
      updatedAt: timestamp.toISOString(),
      version: 1,
    };
    const putRecord = { TableName: this.tableName, Item: item, ConditionExpression: 'attribute_not_exists(PK)' };
    if (!idempotency) {
      await this.client.send(new PutCommand(putRecord));
      return { record: toRecord<T>(item), duplicate: false };
    }

    let raced: unknown;
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  PK: item.PK,
                  SK: `IDEM#${idempotency.clientRequestId}`,
                  type: 'IDEMPOTENCY',
                  entryId: id,
                  entrySK: item.SK,
                  fingerprint: idempotency.fingerprint,
                  createdAt: item.createdAt,
                  expiresAt: Math.floor(timestamp.getTime() / 1000) + IDEMPOTENCY_TTL_SECONDS,
                },
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            { Put: putRecord },
          ],
        }),
      );
      return { record: toRecord<T>(item), duplicate: false };
    } catch (error) {
      const code = error instanceof TransactionCanceledException ? error.CancellationReasons?.[0]?.Code : undefined;
      if (code === 'TransactionConflict') raced = error;
      else if (code !== 'ConditionalCheckFailed') throw error;
    }

    // The clientRequestId was used before (or is being used right now): return the original record.
    const marker = await this.client.send(new GetCommand({ TableName: this.tableName, Key: { PK: item.PK, SK: `IDEM#${idempotency.clientRequestId}` }, ConsistentRead: true }));
    if (!marker.Item) {
      if (raced) throw raced;
      throw new Error('Idempotency marker vanished between write and read');
    }
    if (marker.Item.fingerprint !== idempotency.fingerprint) throw new IdempotencyConflictError(idempotency.clientRequestId);
    const original = await this.client.send(new GetCommand({ TableName: this.tableName, Key: { PK: item.PK, SK: marker.Item.entrySK }, ConsistentRead: true }));
    if (!original.Item) throw new Error('Record referenced by idempotency marker not found');
    return { record: toRecord<T>(original.Item as RecordItem), duplicate: true };
  }

  async findCreated<T extends Record<string, unknown>>(farmId: string, idempotency: Idempotency) {
    const { Item: marker } = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: { PK: `FARM#${farmId}`, SK: `IDEM#${idempotency.clientRequestId}` }, ConsistentRead: true }),
    );
    if (!marker) return undefined;
    if (marker.fingerprint !== idempotency.fingerprint) throw new IdempotencyConflictError(idempotency.clientRequestId);
    return this.get<T>(farmId, String(marker.entryId));
  }

  async get<T extends Record<string, unknown>>(farmId: string, id: string) {
    const parsed = parseRecordId(id);
    if (!parsed) return undefined;
    const { Item } = await this.client.send(new GetCommand({ TableName: this.tableName, Key: { PK: `FARM#${farmId}`, SK: parsed.sortKey }, ConsistentRead: true }));
    return Item ? toRecord<T>(Item as RecordItem) : undefined;
  }

  async update<T extends Record<string, unknown>>(farmId: string, id: string, expectedVersion: number, data: T) {
    const parsed = parseRecordId(id);
    if (!parsed) throw new EntryNotFoundError(id);
    try {
      const { Attributes } = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { PK: `FARM#${farmId}`, SK: parsed.sortKey },
          UpdateExpression: 'SET #data = :data, #updatedAt = :now, #version = :next',
          ConditionExpression: 'attribute_exists(PK) AND #version = :expected',
          ExpressionAttributeNames: { '#data': 'data', '#updatedAt': 'updatedAt', '#version': 'version' },
          ExpressionAttributeValues: { ':data': data, ':now': this.now().toISOString(), ':next': expectedVersion + 1, ':expected': expectedVersion },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return toRecord<T>(Attributes as RecordItem);
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
      throw (await this.get(farmId, id)) ? new ConcurrentModificationError(id) : new EntryNotFoundError(id);
    }
  }

  async list<T extends Record<string, unknown>>(farmId: string, kind: RecordKind, query: RecordQuery = {}) {
    const { lo, hi } = sortKeyRange(kind, query);
    const items: RecordItem[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const page = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'PK = :pk AND SK BETWEEN :lo AND :hi',
          ExpressionAttributeValues: { ':pk': `FARM#${farmId}`, ':lo': lo, ':hi': hi },
          ...(start ? { ExclusiveStartKey: start } : {}),
        }),
      );
      items.push(...((page.Items ?? []) as RecordItem[]));
      if (items.length > MAX_SUMMARY_ENTRIES) throw new TooManyEntriesError();
      start = page.LastEvaluatedKey;
    } while (start);
    return items.map((i) => toRecord<T>(i));
  }
}
