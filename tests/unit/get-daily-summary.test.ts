import { describe, expect, it } from 'vitest';
import { callTool, makeTestConfig } from '../helpers/mcp-http.js';

// Fixed clock: 2026-10-14 12:00 IST.
describe('get_daily_summary tool', () => {
  it('summarises today\'s expenses and activities with server-computed totals', async () => {
    const { config } = makeTestConfig();
    await callTool(config, 'record_expense', { amountRupees: 2500, category: 'feed' });
    await callTool(config, 'record_expense', { amountRupees: 800, category: 'medicine' });
    await callTool(config, 'record_expense', { amountRupees: 150.25, category: 'feed' });
    await callTool(config, 'record_expense', { amountRupees: 999, category: 'fuel', date: '2026-10-13' }); // yesterday
    await callTool(config, 'record_farm_activity', { activityType: 'vaccination', animalOrField: 'brown cow' });
    await callTool(config, 'record_farm_activity', { activityType: 'milking', note: '12 litres' });

    const r = await callTool(config, 'get_daily_summary', {});
    expect(r.isError).toBeFalsy();
    // Hand-calculated: 2500 + 800 + 150.25 = ₹3,450.25; feed = ₹2,650.25.
    expect(r.structuredContent).toMatchObject({
      date: '2026-10-14',
      expenseTotalPaise: 345025,
      expenseTotalDisplay: '₹3,450.25',
      expenseCount: 3,
      topCategory: 'feed',
      byCategory: [
        { category: 'feed', totalPaise: 265025, totalDisplay: '₹2,650.25', entryCount: 2 },
        { category: 'medicine', totalPaise: 80000, totalDisplay: '₹800.00', entryCount: 1 },
      ],
      calculatedBy: 'server',
    });
    expect(r.structuredContent.expenses.map((e: { amountPaise: number }) => e.amountPaise)).toEqual([250000, 80000, 15025]);
    expect(r.structuredContent.activities.map((a: { activityType: string }) => a.activityType)).toEqual(['vaccination', 'milking']);
    expect(r.content[0]!.text).toContain('2026-10-14: Spent ₹3,450.25 (3 expenses, most on feed); 2 activities recorded.');
  });

  it('summarises a past day', async () => {
    const { config } = makeTestConfig();
    await callTool(config, 'record_expense', { amountRupees: 999, category: 'fuel', date: '2026-10-13' });
    const r = await callTool(config, 'get_daily_summary', { date: '2026-10-13' });
    expect(r.structuredContent).toMatchObject({ date: '2026-10-13', expenseTotalPaise: 99900, expenseCount: 1, activities: [] });
    expect(r.content[0]!.text).toContain('2026-10-13: Spent ₹999.00 (1 expense, most on fuel); no activities recorded.');
  });

  it('handles an empty day without a top category', async () => {
    const { config } = makeTestConfig();
    await callTool(config, 'record_farm_activity', { activityType: 'irrigation' });
    const r = await callTool(config, 'get_daily_summary', {});
    expect(r.structuredContent).toMatchObject({ expenseTotalPaise: 0, expenseTotalDisplay: '₹0.00', expenseCount: 0, byCategory: [] });
    expect(r.structuredContent.topCategory).toBeUndefined();
    expect(r.content[0]!.text).toContain('2026-10-14: No expenses; 1 activity recorded.');
  });

  it('rejects invalid and future dates', async () => {
    const { config } = makeTestConfig();
    const bad = await callTool(config, 'get_daily_summary', { date: '2026-02-30' });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toContain('not a real calendar date');
    const future = await callTool(config, 'get_daily_summary', { date: '2026-10-15' });
    expect(future.isError).toBe(true);
    expect(future.content[0]!.text).toContain('in the future');
  });
});
