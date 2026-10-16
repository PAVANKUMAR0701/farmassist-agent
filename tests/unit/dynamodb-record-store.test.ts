import { ConditionalCheckFailedException, DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { DynamoRecordStore } from '../../src/repositories/dynamodb-record-store.js';
import { ConcurrentModificationError, EntryNotFoundError } from '../../src/repositories/ledger-repository.js';
import { newRecordId, parseRecordId } from '../../src/repositories/record-store.js';

const ddb = mockClient(DynamoDBDocumentClient);
const store = new DynamoRecordStore(DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-south-1' })), 'T', () => new Date('2026-10-14T06:30:00Z'));
beforeEach(() => ddb.reset());

describe('record ids', () => {
  it('round-trip to sort keys, and reject anything malformed', () => {
    const milk = newRecordId('milk', { date: '2026-10-14' });
    expect(parseRecordId(milk)).toMatchObject({ kind: 'milk', date: '2026-10-14', sortKey: expect.stringMatching(/^MILK#2026-10-14#[0-9A-Z]{26}$/) });
    const crop = newRecordId('crop');
    expect(parseRecordId(newRecordId('harvest', { cropId: crop }))!.sortKey).toMatch(new RegExp(`^HARVEST#${parseRecordId(crop)!.ulid}#`));
    for (const bad of ['ani_x', 'act_20261016_01M52935999999999999999999', 'ani_01M5293599999999999999999', '../ANIMAL#x']) expect(parseRecordId(bad)).toBeUndefined();
  });
});

describe('DynamoRecordStore', () => {
  it('creates with its idempotency marker in one transaction', async () => {
    ddb.on(TransactWriteCommand).resolves({});
    const id = newRecordId('animal');
    await store.create('farm-1', id, { name: 'Lakshmi', type: 'cow', status: 'active' }, { clientRequestId: 'req-00000001', fingerprint: 'fp' });
    const [marker, record] = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    expect(marker!.Put!.Item).toMatchObject({ PK: 'FARM#farm-1', SK: 'IDEM#req-00000001', entryId: id, fingerprint: 'fp' });
    expect(record!.Put!.Item).toMatchObject({ PK: 'FARM#farm-1', SK: parseRecordId(id)!.sortKey, kind: 'animal', version: 1, data: { name: 'Lakshmi' } });
    expect(record!.Put!.ConditionExpression).toBe('attribute_not_exists(PK)');
  });

  it('replays the original when the marker already exists', async () => {
    ddb.on(TransactWriteCommand).rejects(new TransactionCanceledException({ message: 'x', $metadata: {}, CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }] }));
    const original = newRecordId('animal');
    ddb
      .on(GetCommand, { Key: { PK: 'FARM#farm-1', SK: 'IDEM#req-00000001' } })
      .resolves({ Item: { fingerprint: 'fp', entrySK: parseRecordId(original)!.sortKey, entryId: original } })
      .on(GetCommand, { Key: { PK: 'FARM#farm-1', SK: parseRecordId(original)!.sortKey } })
      .resolves({ Item: { entryId: original, kind: 'animal', farmId: 'farm-1', data: { name: 'Lakshmi' }, version: 1, createdAt: 'c', updatedAt: 'u' } });
    const result = await store.create('farm-1', newRecordId('animal'), { name: 'Lakshmi' }, { clientRequestId: 'req-00000001', fingerprint: 'fp' });
    expect(result).toMatchObject({ duplicate: true, record: { id: original } });
  });

  it('updates with a version condition; a failed condition becomes concurrent-change or not-found', async () => {
    const id = newRecordId('reminder', { date: '2026-10-20' });
    ddb.on(UpdateCommand).resolves({ Attributes: { entryId: id, kind: 'reminder', farmId: 'f', data: { status: 'done' }, version: 2, createdAt: 'c', updatedAt: 'u' } });
    await store.update('f', id, 1, { status: 'done' });
    const input = ddb.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.ConditionExpression).toBe('attribute_exists(PK) AND #version = :expected');
    expect(input.ExpressionAttributeValues).toMatchObject({ ':expected': 1, ':next': 2 });

    ddb.reset();
    ddb.on(UpdateCommand).rejects(new ConditionalCheckFailedException({ message: 'x', $metadata: {} }));
    ddb.on(GetCommand).resolves({ Item: { entryId: id, version: 3 } });
    await expect(store.update('f', id, 1, {})).rejects.toBeInstanceOf(ConcurrentModificationError);
    ddb.on(GetCommand).resolves({});
    await expect(store.update('f', id, 1, {})).rejects.toBeInstanceOf(EntryNotFoundError);
  });

  it('queries one kind, date-bounded for milk and reminders, crop-bounded for harvests', async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });
    await store.list('f', 'milk', { from: '2026-10-08', to: '2026-10-14' });
    await store.list('f', 'animal');
    const crop = newRecordId('crop');
    await store.list('f', 'harvest', { cropId: crop });
    const [milk, animals, harvests] = ddb.commandCalls(QueryCommand).map((c) => c.args[0].input.ExpressionAttributeValues!);
    expect(milk).toEqual({ ':pk': 'FARM#f', ':lo': 'MILK#2026-10-08#', ':hi': 'MILK#2026-10-14#~' });
    expect(animals).toMatchObject({ ':lo': 'ANIMAL#', ':hi': 'ANIMAL#~' });
    expect(harvests).toMatchObject({ ':lo': `HARVEST#${parseRecordId(crop)!.ulid}#` });
  });

  it('creates without idempotency as a single conditional put', async () => {
    ddb.on(PutCommand).resolves({});
    await store.create('f', newRecordId('crop'), { crop: 'paddy' });
    expect(ddb.commandCalls(PutCommand)[0]!.args[0].input.ConditionExpression).toBe('attribute_not_exists(PK)');
  });
});
