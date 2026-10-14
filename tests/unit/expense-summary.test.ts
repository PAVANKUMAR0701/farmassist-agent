import { describe, expect, it } from 'vitest';
import type { ExpenseCategory, ExpenseEntry } from '../../src/domain/expense.js';
import { summarizeExpenses } from '../../src/domain/expense-summary.js';

let n = 0;
const entry = (date: string, category: ExpenseCategory, amountPaise: number): ExpenseEntry => ({
  entryId: `exp_${date.replaceAll('-', '')}_${String(n++).padStart(26, '0')}`,
  farmId: 'f',
  date,
  category,
  amountPaise,
  createdAt: '',
  updatedAt: '',
  version: 1,
});

const entries = [
  entry('2026-10-01', 'feed', 250000), // ₹2,500
  entry('2026-10-01', 'medicine', 90000), // ₹900
  entry('2026-10-03', 'feed', 120050), // ₹1,200.50
  entry('2026-10-05', 'labour', 90000), // ₹900
];

describe('summarizeExpenses', () => {
  it('totals by category, largest first, ties alphabetical (hand-calculated values)', () => {
    const result = summarizeExpenses(entries, 'category');
    expect(result.totalPaise).toBe(550050); // 2500 + 900 + 1200.50 + 900 = ₹5,500.50
    expect(result.entryCount).toBe(4);
    expect(result.groups).toEqual([
      { key: 'feed', totalPaise: 370050, entryCount: 2 },
      { key: 'labour', totalPaise: 90000, entryCount: 1 },
      { key: 'medicine', totalPaise: 90000, entryCount: 1 },
    ]);
  });

  it('totals by day in date order', () => {
    const result = summarizeExpenses(entries, 'day');
    expect(result.groups).toEqual([
      { key: '2026-10-01', totalPaise: 340000, entryCount: 2 },
      { key: '2026-10-03', totalPaise: 120050, entryCount: 1 },
      { key: '2026-10-05', totalPaise: 90000, entryCount: 1 },
    ]);
  });

  it('group totals always add up to the overall total', () => {
    for (const groupBy of ['category', 'day'] as const) {
      const result = summarizeExpenses(entries, groupBy);
      expect(result.groups.reduce((sum, g) => sum + g.totalPaise, 0)).toBe(result.totalPaise);
    }
  });

  it('returns zero for no entries', () => {
    expect(summarizeExpenses([], 'category')).toEqual({ totalPaise: 0, entryCount: 0, groups: [] });
  });

  it('refuses non-integer amounts instead of silently adding them', () => {
    expect(() => summarizeExpenses([entry('2026-10-01', 'feed', 10.5)], 'category')).toThrow(RangeError);
  });
});
