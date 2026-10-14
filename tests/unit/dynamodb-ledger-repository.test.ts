import { DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { DynamoLedgerRepository } from '../../src/repositories/dynamodb-ledger-repository.js';
import { IdempotencyConflictError, TooManyEntriesError } from '../../src/repositories/ledger-repository.js';

// These tests check the exact DynamoDB requests we build (keys, conditions, atomicity).
// Real conditional-write behaviour is verified against a deployed table in the integration tests (Phase 2).

const TABLE = 'FarmLedgerTest';
const NOW = new Date('2026-10-14T06:30:00Z');
const ddb = mockClient(DynamoDBDocumentClient);
const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-south-1' }));
const repo = new DynamoLedgerRepository(docClient, TABLE, () => NOW);
const newExpense = { farmId: 'farm-1', date: '2026-10-14', category: 'feed' as const, amountPaise: 250000 };

beforeEach(() => ddb.reset());

describe('DynamoLedgerRepository.createExpense', () => {
  it('without idempotency: one conditional Put with farm/date keys', async () => {
    ddb.on(PutCommand).resolves({});
    const { entry, duplicate } = await repo.createExpense(newExpense);

    expect(duplicate).toBe(false);
    const put = ddb.commandCalls(PutCommand)[0]!.args[0].input;
    expect(put.TableName).toBe(TABLE);
    expect(put.ConditionExpression).toBe('attribute_not_exists(PK)');
    expect(put.Item).toMatchObject({ PK: 'FARM#farm-1', type: 'EXPENSE', amountPaise: 250000, version: 1, entryId: entry.entryId });
    expect(put.Item!.SK).toMatch(/^EXP#2026-10-14#[0-9A-Z]{26}$/);
  });

  it('with idempotency: writes the marker and the expense in one transaction', async () => {
    ddb.on(TransactWriteCommand).resolves({});
    const { entry } = await repo.createExpense(newExpense, { clientRequestId: 'req-12345678', fingerprint: 'fp-1' });

    const items = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    expect(items).toHaveLength(2);
    const [marker, expense] = items.map((i) => i.Put!);
    expect(marker!.Item).toMatchObject({
      PK: 'FARM#farm-1',
      SK: 'IDEM#req-12345678',
      entryId: entry.entryId,
      fingerprint: 'fp-1',
      expiresAt: Math.floor(NOW.getTime() / 1000) + 7 * 24 * 60 * 60,
    });
    expect(marker!.Item!.entrySK).toBe(expense!.Item!.SK);
    expect(marker!.ConditionExpression).toBe('attribute_not_exists(PK)');
    expect(expense!.ConditionExpression).toBe('attribute_not_exists(PK)');
  });

  it('replays the original entry when the marker already exists with the same fingerprint', async () => {
    ddb.on(TransactWriteCommand).rejects(
      new TransactionCanceledException({
        message: 'Transaction cancelled',
        $metadata: {},
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
      }),
    );
    const originalItem = {
      PK: 'FARM#farm-1',
      SK: 'EXP#2026-10-14#01JORIGINAL0000000000000000',
      type: 'EXPENSE',
      entryId: 'exp_20261014_01JORIGINAL0000000000000000',
      farmId: 'farm-1',
      date: '2026-10-14',
      category: 'feed',
      amountPaise: 250000,
      createdAt: '2026-10-14T06:00:00.000Z',
      updatedAt: '2026-10-14T06:00:00.000Z',
      version: 1,
    };
    ddb
      .on(GetCommand, { Key: { PK: 'FARM#farm-1', SK: 'IDEM#req-12345678' } })
      .resolves({ Item: { fingerprint: 'fp-1', entrySK: originalItem.SK } })
      .on(GetCommand, { Key: { PK: 'FARM#farm-1', SK: originalItem.SK } })
      .resolves({ Item: originalItem });

    const result = await repo.createExpense(newExpense, { clientRequestId: 'req-12345678', fingerprint: 'fp-1' });
    expect(result.duplicate).toBe(true);
    expect(result.entry.entryId).toBe(originalItem.entryId);
    expect(ddb.commandCalls(GetCommand).every((c) => c.args[0].input.ConsistentRead === true)).toBe(true);
  });

  it('throws IdempotencyConflictError when the marker exists with a different fingerprint', async () => {
    ddb.on(TransactWriteCommand).rejects(
      new TransactionCanceledException({
        message: 'Transaction cancelled',
        $metadata: {},
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
      }),
    );
    ddb.on(GetCommand).resolves({ Item: { fingerprint: 'other', entrySK: 'EXP#x' } });

    await expect(repo.createExpense(newExpense, { clientRequestId: 'req-12345678', fingerprint: 'fp-1' })).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
  });

  it('rethrows other transaction failures unchanged', async () => {
    const throttled = new TransactionCanceledException({
      message: 'Transaction cancelled',
      $metadata: {},
      CancellationReasons: [{ Code: 'ThrottlingError' }, { Code: 'None' }],
    });
    ddb.on(TransactWriteCommand).rejects(throttled);
    await expect(repo.createExpense(newExpense, { clientRequestId: 'req-12345678', fingerprint: 'fp-1' })).rejects.toBe(throttled);
  });
});

const item = (date: string, ulid: string, category = 'feed', amountPaise = 1000) => ({
  PK: 'FARM#farm-1',
  SK: `EXP#${date}#${ulid}`,
  type: 'EXPENSE',
  entryId: `exp_${date.replaceAll('-', '')}_${ulid}`,
  farmId: 'farm-1',
  date,
  category,
  amountPaise,
  createdAt: '2026-10-14T06:00:00.000Z',
  updatedAt: '2026-10-14T06:00:00.000Z',
  version: 1,
});
const U = (n: number) => `01J${String(n).padStart(23, '0')}`;

describe('DynamoLedgerRepository range queries', () => {
  const range = { farmId: 'farm-1', from: '2026-10-01', to: '2026-10-14' };

  it('listExpenses queries one farm partition, date-bounded, newest first', async () => {
    ddb.on(QueryCommand).resolves({ Items: [item('2026-10-14', U(2)), item('2026-10-10', U(1))] });
    const page = await repo.listExpenses({ ...range, limit: 20 });

    const input = ddb.commandCalls(QueryCommand)[0]!.args[0].input;
    expect(input.KeyConditionExpression).toBe('PK = :pk AND SK BETWEEN :lo AND :hi');
    expect(input.ExpressionAttributeValues).toEqual({ ':pk': 'FARM#farm-1', ':lo': 'EXP#2026-10-01#', ':hi': 'EXP#2026-10-14#~' });
    expect(input.ScanIndexForward).toBe(false);
    expect(input.FilterExpression).toBeUndefined();
    expect(page.items.map((e) => e.date)).toEqual(['2026-10-14', '2026-10-10']);
    expect(page.nextCursor).toBeUndefined();
  });

  it('keeps reading pages when a category filter leaves too few matches, and returns a cursor', async () => {
    ddb
      .on(QueryCommand)
      .resolvesOnce({ Items: [item('2026-10-14', U(5))], LastEvaluatedKey: { PK: 'FARM#farm-1', SK: `EXP#2026-10-14#${U(5)}` } })
      .resolvesOnce({ Items: [item('2026-10-12', U(4)), item('2026-10-11', U(3))] });
    const page = await repo.listExpenses({ ...range, category: 'feed', limit: 2 });

    const calls = ddb.commandCalls(QueryCommand);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.args[0].input.FilterExpression).toBe('#category = :category');
    expect(calls[0]!.args[0].input.ExpressionAttributeNames).toEqual({ '#category': 'category' });
    expect(calls[1]!.args[0].input.ExclusiveStartKey).toEqual({ PK: 'FARM#farm-1', SK: `EXP#2026-10-14#${U(5)}` });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeDefined();

    // The cursor resumes after the last returned item.
    ddb.reset();
    ddb.on(QueryCommand).resolves({ Items: [item('2026-10-11', U(3))] });
    await repo.listExpenses({ ...range, category: 'feed', limit: 2, cursor: page.nextCursor });
    expect(ddb.commandCalls(QueryCommand)[0]!.args[0].input.ExclusiveStartKey).toEqual({ PK: 'FARM#farm-1', SK: `EXP#2026-10-12#${U(4)}` });
  });

  it('getAllExpenses follows LastEvaluatedKey until the range is exhausted', async () => {
    ddb
      .on(QueryCommand)
      .resolvesOnce({ Items: [item('2026-10-01', U(1))], LastEvaluatedKey: { PK: 'FARM#farm-1', SK: `EXP#2026-10-01#${U(1)}` } })
      .resolvesOnce({ Items: [item('2026-10-02', U(2))] });
    const all = await repo.getAllExpenses(range);
    expect(all).toHaveLength(2);
    expect(ddb.commandCalls(QueryCommand)).toHaveLength(2);
  });

  it('getAllExpenses stops with TooManyEntriesError past the safety cap', async () => {
    const big = Array.from({ length: 10_001 }, (_, i) => item('2026-10-01', U(i)));
    ddb.on(QueryCommand).resolves({ Items: big });
    await expect(repo.getAllExpenses(range)).rejects.toBeInstanceOf(TooManyEntriesError);
  });
});

describe('DynamoLedgerRepository activities', () => {
  it('createActivity writes an ACT# item and its idempotency marker atomically', async () => {
    ddb.on(TransactWriteCommand).resolves({});
    const { entry } = await repo.createActivity(
      { farmId: 'farm-1', date: '2026-10-14', activityType: 'vaccination', animalOrField: 'brown cow' },
      { clientRequestId: 'act-req-0001', fingerprint: 'fp-a' },
    );

    const [marker, activity] = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!.map((i) => i.Put!);
    expect(activity!.Item).toMatchObject({ PK: 'FARM#farm-1', type: 'ACTIVITY', activityType: 'vaccination', animalOrField: 'brown cow' });
    expect(activity!.Item!.SK).toMatch(/^ACT#2026-10-14#[0-9A-Z]{26}$/);
    expect(marker!.Item).toMatchObject({ SK: 'IDEM#act-req-0001', entryId: entry.entryId, entrySK: activity!.Item!.SK });
    expect(entry.entryId).toMatch(/^act_20261014_/);
  });

  it('getActivities queries only ACT# keys in the date range, oldest first', async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });
    await repo.getActivities({ farmId: 'farm-1', from: '2026-10-14', to: '2026-10-14' });
    const input = ddb.commandCalls(QueryCommand)[0]!.args[0].input;
    expect(input.ExpressionAttributeValues).toEqual({ ':pk': 'FARM#farm-1', ':lo': 'ACT#2026-10-14#', ':hi': 'ACT#2026-10-14#~' });
    expect(input.ScanIndexForward).toBeUndefined(); // DynamoDB default: ascending
  });
});
