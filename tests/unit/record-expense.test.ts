import { describe, expect, it } from 'vitest';
import { callTool, makeTestConfig, TEST_FARM_ID } from '../helpers/mcp-http.js';

describe('record_expense tool', () => {
  it('records ₹2,500 of feed as integer paise, dated today in IST', async () => {
    const { config, ledger } = makeTestConfig();
    const result = await callTool(config, 'record_expense', { amountRupees: 2500, category: 'feed', note: 'cattle feed' });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      duplicate: false,
      entry: { date: '2026-10-14', category: 'feed', amountPaise: 250000, amountDisplay: '₹2,500.00', note: 'cattle feed' },
    });
    expect(result.structuredContent.entry.entryId).toMatch(/^exp_20261014_[0-9A-Z]{26}$/);

    const stored = [...ledger.expenses.values()];
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ farmId: TEST_FARM_ID, amountPaise: 250000, version: 1 });
  });

  it('uses the IST date, not the UTC date, just after IST midnight', async () => {
    // 2026-10-14 19:00 UTC is 2026-10-15 00:30 IST.
    const { config } = makeTestConfig(new Date('2026-10-14T19:00:00Z'));
    const result = await callTool(config, 'record_expense', { amountRupees: 800, category: 'medicine' });
    expect(result.structuredContent.entry.date).toBe('2026-10-15');
  });

  it('accepts an explicit past date', async () => {
    const { config } = makeTestConfig();
    const result = await callTool(config, 'record_expense', { amountRupees: 300, category: 'fuel', date: '2026-10-01' });
    expect(result.structuredContent.entry.date).toBe('2026-10-01');
  });

  it('does not create a duplicate when the same clientRequestId is retried', async () => {
    const { config, ledger } = makeTestConfig();
    const args = { amountRupees: 2500, category: 'feed', clientRequestId: 'req-12345678' };
    const first = await callTool(config, 'record_expense', args);
    const retry = await callTool(config, 'record_expense', args);

    expect(first.structuredContent.duplicate).toBe(false);
    expect(retry.structuredContent.duplicate).toBe(true);
    expect(retry.structuredContent.entry.entryId).toBe(first.structuredContent.entry.entryId);
    expect(ledger.expenses.size).toBe(1);
  });

  it('rejects reusing a clientRequestId for a different expense', async () => {
    const { config, ledger } = makeTestConfig();
    await callTool(config, 'record_expense', { amountRupees: 2500, category: 'feed', clientRequestId: 'req-12345678' });
    const conflict = await callTool(config, 'record_expense', { amountRupees: 900, category: 'feed', clientRequestId: 'req-12345678' });

    expect(conflict.isError).toBe(true);
    expect(conflict.content[0]!.text).toContain('already used for a different expense');
    expect(ledger.expenses.size).toBe(1);
  });

  it.each([
    ['zero amount', { amountRupees: 0, category: 'feed' }],
    ['negative amount', { amountRupees: -50, category: 'feed' }],
    ['three decimals', { amountRupees: 10.555, category: 'feed' }],
    ['amount above ₹1 crore', { amountRupees: 10_000_001, category: 'feed' }],
    ['amount as text', { amountRupees: '2500', category: 'feed' }],
    ['unknown category', { amountRupees: 100, category: 'snacks' }],
    ['missing category', { amountRupees: 100 }],
    ['missing amount', { category: 'feed' }],
    ['impossible date', { amountRupees: 100, category: 'feed', date: '2026-02-30' }],
    ['wrong date format', { amountRupees: 100, category: 'feed', date: '14/10/2026' }],
    ['future date', { amountRupees: 100, category: 'feed', date: '2026-10-15' }],
    ['note too long', { amountRupees: 100, category: 'feed', note: 'x'.repeat(201) }],
    ['bad clientRequestId', { amountRupees: 100, category: 'feed', clientRequestId: 'bad id!' }],
  ])('rejects %s with a tool error and saves nothing', async (_label, args) => {
    const { config, ledger } = makeTestConfig();
    const result = await callTool(config, 'record_expense', args);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text.length).toBeGreaterThan(0);
    expect(ledger.expenses.size).toBe(0);
  });

  it('hides internal storage errors behind a generic message', async () => {
    const { config } = makeTestConfig();
    config.deps.ledger.createExpense = async () => {
      throw new Error('AccessDeniedException: arn:aws:dynamodb:ap-south-1:123456789012:table/secret-table');
    };
    const original = console.error;
    console.error = () => {};
    try {
      const result = await callTool(config, 'record_expense', { amountRupees: 100, category: 'feed' });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).not.toContain('arn:aws');
      expect(result.content[0]!.text).toContain('Nothing was changed');
    } finally {
      console.error = original;
    }
  });
});
