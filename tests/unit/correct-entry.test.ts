import { describe, expect, it } from 'vitest';
import { callTool, makeTestConfig, TEST_FARM_ID, TEST_TOKEN } from '../helpers/mcp-http.js';

describe('correct_entry tool', () => {
  it('demo flow: ₹800 medicine, then "No, it was ₹900" by entryId', async () => {
    const { config, ledger } = makeTestConfig();
    const recorded = await callTool(config, 'record_expense', { amountRupees: 800, category: 'medicine', note: 'cow medicine' });
    const entryId = recorded.structuredContent.entry.entryId;

    const r = await callTool(config, 'correct_entry', { entryId, newAmountRupees: 900, reason: 'it was 900 not 800' });

    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({
      status: 'corrected',
      entry: { entryId, amountPaise: 90000, amountDisplay: '₹900.00', category: 'medicine', note: 'cow medicine' },
      before: { amountPaise: 80000, amountDisplay: '₹800.00' },
      after: { amountPaise: 90000, amountDisplay: '₹900.00' },
      changedFields: ['amountPaise'],
    });
    expect(r.content[0]!.text).toContain('Corrected the medicine expense on 2026-10-14: amount ₹800.00 → ₹900.00.');

    // The stored entry changed in place (no second entry) and its version went up.
    expect(ledger.expenses.size).toBe(1);
    expect(ledger.expenses.get(entryId)).toMatchObject({ amountPaise: 90000, version: 2 });

    // The audit trail keeps before/after.
    const audit = await ledger.getCorrections(TEST_FARM_ID, entryId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      correctionId: r.structuredContent.correctionId,
      before: { amountPaise: 80000 },
      after: { amountPaise: 90000 },
      reason: 'it was 900 not 800',
      fromVersion: 1,
      toVersion: 2,
    });

    // Totals use the corrected amount.
    const total = await callTool(config, 'get_expense_summary', { period: 'today', category: 'medicine' });
    expect(total.structuredContent.totalPaise).toBe(90000);
  });

  it('finds the only matching expense with match (no entryId)', async () => {
    const { config } = makeTestConfig();
    await callTool(config, 'record_expense', { amountRupees: 2500, category: 'feed' });
    await callTool(config, 'record_expense', { amountRupees: 800, category: 'medicine' });
    const r = await callTool(config, 'correct_entry', { match: { category: 'medicine' }, newAmountRupees: 900 });
    expect(r.structuredContent).toMatchObject({ status: 'corrected', entry: { category: 'medicine', amountPaise: 90000 } });
  });

  it('asks instead of guessing when several expenses match, and changes nothing', async () => {
    const { config, ledger } = makeTestConfig();
    await callTool(config, 'record_expense', { amountRupees: 800, category: 'medicine', note: 'cow' });
    await callTool(config, 'record_expense', { amountRupees: 450, category: 'medicine', note: 'goat' });

    const r = await callTool(config, 'correct_entry', { match: { category: 'medicine' }, newAmountRupees: 900 });

    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.status).toBe('needs_clarification');
    expect(r.structuredContent.candidates.map((c: { note: string }) => c.note)).toEqual(['goat', 'cow']); // newest first
    expect(r.content[0]!.text).toContain('Ask the farmer which one');
    expect([...ledger.expenses.values()].every((e) => e.version === 1)).toBe(true);
    expect(ledger.corrections).toHaveLength(0);
  });

  it('changes category and removes the note', async () => {
    const { config } = makeTestConfig();
    const rec = await callTool(config, 'record_expense', { amountRupees: 300, category: 'other', note: 'diesel' });
    const r = await callTool(config, 'correct_entry', { entryId: rec.structuredContent.entry.entryId, newCategory: 'fuel', newNote: '' });
    expect(r.structuredContent.changedFields).toEqual(['category', 'note']);
    expect(r.structuredContent.entry).not.toHaveProperty('note');
    expect(r.structuredContent.entry.category).toBe('fuel');
  });

  it('reports no_change when the values are already the same', async () => {
    const { config, ledger } = makeTestConfig();
    const rec = await callTool(config, 'record_expense', { amountRupees: 900, category: 'medicine' });
    const r = await callTool(config, 'correct_entry', { entryId: rec.structuredContent.entry.entryId, newAmountRupees: 900 });
    expect(r.structuredContent.status).toBe('no_change');
    expect(ledger.corrections).toHaveLength(0);
  });

  it('refuses to overwrite a change made by someone else in between (optimistic locking)', async () => {
    const { config, ledger } = makeTestConfig();
    const rec = await callTool(config, 'record_expense', { amountRupees: 800, category: 'medicine' });
    const entryId = rec.structuredContent.entry.entryId;
    const staleCopy = await ledger.getExpense(TEST_FARM_ID, entryId); // version 1
    await callTool(config, 'correct_entry', { entryId, newAmountRupees: 900 }); // now version 2

    // Simulate a second request that read the entry before the first correction was saved.
    ledger.getExpense = async () => staleCopy;
    const r = await callTool(config, 'correct_entry', { entryId, newAmountRupees: 1000 });

    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('changed by another request');
    expect(ledger.expenses.get(entryId)!.amountPaise).toBe(90000);
    expect(ledger.corrections).toHaveLength(1);
  });

  it('cannot correct another farm\'s entry', async () => {
    const { config, ledger } = makeTestConfig();
    const rec = await callTool(config, 'record_expense', { amountRupees: 800, category: 'medicine' });
    const asOtherFarm = { ...config, apiTokens: [{ token: TEST_TOKEN, farmId: 'other-farm', clientId: 'test' }] };
    const r = await callTool(asOtherFarm, 'correct_entry', { entryId: rec.structuredContent.entry.entryId, newAmountRupees: 1 });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('was found');
    expect([...ledger.expenses.values()][0]!.amountPaise).toBe(80000);
  });

  it.each([
    ['neither entryId nor match', { newAmountRupees: 900 }],
    ['both entryId and match', { entryId: 'exp_20261014_01J00000000000000000000000', match: {}, newAmountRupees: 900 }],
    ['no new values', { entryId: 'exp_20261014_01J00000000000000000000000' }],
    ['malformed entryId', { entryId: 'abc', newAmountRupees: 900 }],
    ['unknown entryId', { entryId: 'exp_20261014_01J00000000000000000000000', newAmountRupees: 900 }],
    ['activity id', { entryId: 'act_20261014_01J00000000000000000000000', newAmountRupees: 900 }],
    ['negative amount', { entryId: 'exp_20261014_01J00000000000000000000000', newAmountRupees: -900 }],
    ['nothing matches', { match: { category: 'seed' }, newAmountRupees: 900 }],
    ['future match date', { match: { date: '2026-10-15' }, newAmountRupees: 900 }],
  ])('rejects %s', async (_label, args) => {
    const { config, ledger } = makeTestConfig();
    await callTool(config, 'record_expense', { amountRupees: 800, category: 'medicine' });
    const r = await callTool(config, 'correct_entry', args);
    expect(r.isError).toBe(true);
    expect(ledger.corrections).toHaveLength(0);
  });
});
