import { describe, expect, it } from 'vitest';
import type { McpHttpConfig } from '../../src/mcp/http.js';
import { callTool, makeTestConfig, TEST_TOKEN } from '../helpers/mcp-http.js';

// Fixed clock: 2026-10-14 12:00 IST (a Wednesday).
async function seed(config: McpHttpConfig) {
  const rows: Array<[number, string, string]> = [
    [2500, 'feed', '2026-10-14'],
    [800, 'medicine', '2026-10-14'],
    [1200.5, 'feed', '2026-10-10'],
    [300, 'fuel', '2026-10-02'],
    [999.99, 'feed', '2026-09-30'], // last month
  ];
  for (const [amountRupees, category, date] of rows) {
    const r = await callTool(config, 'record_expense', { amountRupees, category, date });
    expect(r.isError).toBeFalsy();
  }
}

describe('get_expense_summary', () => {
  it('answers "how much on feed this month" from saved entries only', async () => {
    const { config } = makeTestConfig();
    await seed(config);
    const r = await callTool(config, 'get_expense_summary', { period: 'this_month', category: 'feed' });

    expect(r.isError).toBeFalsy();
    // Hand-calculated: 2500 + 1200.50 = ₹3,700.50 (the ₹999.99 on 30 Sep is last month and excluded).
    expect(r.structuredContent).toMatchObject({
      range: { from: '2026-10-01', to: '2026-10-14', label: 'this_month' },
      category: 'feed',
      totalPaise: 370050,
      totalDisplay: '₹3,700.50',
      entryCount: 2,
      calculatedBy: 'server',
    });
    expect(r.content[0]!.text).toContain('Spent ₹3,700.50 on feed from 2026-10-01 to 2026-10-14 (2 entries).');
  });

  it('defaults to this month, grouped by category', async () => {
    const { config } = makeTestConfig();
    await seed(config);
    const r = await callTool(config, 'get_expense_summary', {});
    // 2500 + 800 + 1200.50 + 300 = ₹4,800.50
    expect(r.structuredContent.totalPaise).toBe(480050);
    expect(r.structuredContent.groups.map((g: { key: string }) => g.key)).toEqual(['feed', 'medicine', 'fuel']);
  });

  it('supports last_month and explicit ranges grouped by day', async () => {
    const { config } = makeTestConfig();
    await seed(config);
    const last = await callTool(config, 'get_expense_summary', { period: 'last_month' });
    expect(last.structuredContent.totalPaise).toBe(99999);

    const byDay = await callTool(config, 'get_expense_summary', { from: '2026-10-10', to: '2026-10-14', groupBy: 'day' });
    expect(byDay.structuredContent.groups).toEqual([
      { key: '2026-10-10', totalPaise: 120050, totalDisplay: '₹1,200.50', entryCount: 1 },
      { key: '2026-10-14', totalPaise: 330000, totalDisplay: '₹3,300.00', entryCount: 2 },
    ]);
  });

  it('returns a clear zero when nothing was recorded', async () => {
    const { config } = makeTestConfig();
    const r = await callTool(config, 'get_expense_summary', { period: 'today' });
    expect(r.structuredContent).toMatchObject({ totalPaise: 0, totalDisplay: '₹0.00', entryCount: 0, groups: [] });
  });

  it.each([
    ['period and from together', { period: 'today', from: '2026-10-01' }],
    ['to without from', { to: '2026-10-01' }],
    ['from after to', { from: '2026-10-10', to: '2026-10-01' }],
    ['impossible date', { from: '2026-02-30' }],
    ['range over 366 days', { from: '2025-01-01', to: '2026-10-14' }],
    ['unknown period', { period: 'fortnight' }],
  ])('rejects %s', async (_label, args) => {
    const { config } = makeTestConfig();
    const r = await callTool(config, 'get_expense_summary', args);
    expect(r.isError).toBe(true);
  });
});

describe('list_expenses', () => {
  it('lists this month newest first with display amounts', async () => {
    const { config } = makeTestConfig();
    await seed(config);
    const r = await callTool(config, 'list_expenses', {});
    const items = r.structuredContent.items;
    expect(items.map((i: { date: string }) => i.date)).toEqual(['2026-10-14', '2026-10-14', '2026-10-10', '2026-10-02']);
    // Same day: most recently recorded first.
    expect(items[0]).toMatchObject({ category: 'medicine', amountDisplay: '₹800.00' });
    expect(r.structuredContent.nextCursor).toBeUndefined();
  });

  it('pages through every entry exactly once', async () => {
    const { config } = makeTestConfig();
    await seed(config);
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const r = await callTool(config, 'list_expenses', { from: '2026-09-01', limit: 2, ...(cursor ? { cursor } : {}) });
      expect(r.isError).toBeFalsy();
      seen.push(...r.structuredContent.items.map((i: { entryId: string }) => i.entryId));
      cursor = r.structuredContent.nextCursor;
      pages++;
    } while (cursor && pages < 10);

    expect(pages).toBe(3); // 5 entries, 2 per page
    expect(new Set(seen).size).toBe(5);
  });

  it('filters by category', async () => {
    const { config } = makeTestConfig();
    await seed(config);
    const r = await callTool(config, 'list_expenses', { category: 'feed' });
    expect(r.structuredContent.items).toHaveLength(2);
    expect(r.structuredContent.items.every((i: { category: string }) => i.category === 'feed')).toBe(true);
  });

  it('rejects a cursor reused with different filters, or tampered', async () => {
    const { config } = makeTestConfig();
    await seed(config);
    const first = await callTool(config, 'list_expenses', { limit: 1 });
    const cursor = first.structuredContent.nextCursor;
    expect(cursor).toBeDefined();

    const otherFilter = await callTool(config, 'list_expenses', { limit: 1, category: 'feed', cursor });
    expect(otherFilter.isError).toBe(true);
    const garbage = await callTool(config, 'list_expenses', { cursor: 'not-a-real-cursor' });
    expect(garbage.isError).toBe(true);
  });
});

describe('farm isolation', () => {
  it('a second farm token sees none of the first farm\'s data, even with its cursor', async () => {
    const { config } = makeTestConfig();
    await seed(config);
    const farmACursor = (await callTool(config, 'list_expenses', { limit: 1 })).structuredContent.nextCursor;

    // Same database, but this token belongs to a different farm.
    const asFarmB = { ...config, apiTokens: [{ token: TEST_TOKEN, farmId: 'other-farm', clientId: 'test' }] };
    const summary = await callTool(asFarmB, 'get_expense_summary', {});
    expect(summary.structuredContent.totalPaise).toBe(0);
    const list = await callTool(asFarmB, 'list_expenses', {});
    expect(list.structuredContent.items).toEqual([]);
    const stolenCursor = await callTool(asFarmB, 'list_expenses', { limit: 1, cursor: farmACursor });
    expect(stolenCursor.isError).toBe(true);
  });
});
