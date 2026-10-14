import { DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { DynamoLedgerRepository } from '../../src/repositories/dynamodb-ledger-repository.js';
import { IdempotencyConflictError } from '../../src/repositories/ledger-repository.js';

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
    expect(marker!.Item!.expenseSK).toBe(expense!.Item!.SK);
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
      .resolves({ Item: { fingerprint: 'fp-1', expenseSK: originalItem.SK } })
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
    ddb.on(GetCommand).resolves({ Item: { fingerprint: 'other', expenseSK: 'EXP#x' } });

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
