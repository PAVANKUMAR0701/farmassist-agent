import type { ExpenseEntry } from './expense.js';

export type SummaryGroupBy = 'category' | 'day' | 'month';

export interface SummaryGroup {
  key: string;
  totalPaise: number;
  entryCount: number;
  /** Month groups only: that month's totals by category (largest first). */
  categories?: SummaryGroup[];
}

export interface ExpenseSummary {
  totalPaise: number;
  entryCount: number;
  groups: SummaryGroup[];
}

/**
 * Deterministic totals: integer paise added in code, never by the language model.
 * Category groups are sorted by total (largest first, ties by name); day and month (YYYY-MM) groups by date.
 */
const byTotal = (a: SummaryGroup, b: SummaryGroup) => b.totalPaise - a.totalPaise || a.key.localeCompare(b.key);

export function summarizeExpenses(entries: readonly ExpenseEntry[], groupBy: SummaryGroupBy): ExpenseSummary {
  const groups = new Map<string, SummaryGroup>();
  const monthCategories = new Map<string, Map<string, SummaryGroup>>();
  let totalPaise = 0;
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.amountPaise)) throw new RangeError(`Entry ${entry.entryId} has a non-integer amount`);
    totalPaise += entry.amountPaise;
    const key = groupBy === 'category' ? entry.category : groupBy === 'month' ? entry.date.slice(0, 7) : entry.date;
    const group = groups.get(key) ?? { key, totalPaise: 0, entryCount: 0 };
    group.totalPaise += entry.amountPaise;
    group.entryCount += 1;
    groups.set(key, group);
    if (groupBy === 'month') {
      const sub = (monthCategories.get(key) ?? new Map<string, SummaryGroup>()).set(entry.category, monthCategories.get(key)?.get(entry.category) ?? { key: entry.category, totalPaise: 0, entryCount: 0 });
      const category = sub.get(entry.category)!;
      category.totalPaise += entry.amountPaise;
      category.entryCount += 1;
      monthCategories.set(key, sub);
    }
  }
  for (const [month, categories] of monthCategories) groups.get(month)!.categories = [...categories.values()].sort(byTotal);
  if (!Number.isSafeInteger(totalPaise)) throw new RangeError('Total exceeds the safe integer range');

  const sorted = [...groups.values()].sort((a, b) => (groupBy === 'category' ? byTotal(a, b) : a.key.localeCompare(b.key)));
  return { totalPaise, entryCount: entries.length, groups: sorted };
}
