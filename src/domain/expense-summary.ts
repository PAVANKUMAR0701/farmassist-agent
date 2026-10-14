import type { ExpenseEntry } from './expense.js';

export type SummaryGroupBy = 'category' | 'day';

export interface SummaryGroup {
  key: string;
  totalPaise: number;
  entryCount: number;
}

export interface ExpenseSummary {
  totalPaise: number;
  entryCount: number;
  groups: SummaryGroup[];
}

/**
 * Deterministic totals: integer paise added in code, never by the language model.
 * Category groups are sorted by total (largest first, ties by name); day groups by date.
 */
export function summarizeExpenses(entries: readonly ExpenseEntry[], groupBy: SummaryGroupBy): ExpenseSummary {
  const groups = new Map<string, SummaryGroup>();
  let totalPaise = 0;
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.amountPaise)) throw new RangeError(`Entry ${entry.entryId} has a non-integer amount`);
    totalPaise += entry.amountPaise;
    const key = groupBy === 'category' ? entry.category : entry.date;
    const group = groups.get(key) ?? { key, totalPaise: 0, entryCount: 0 };
    group.totalPaise += entry.amountPaise;
    group.entryCount += 1;
    groups.set(key, group);
  }
  if (!Number.isSafeInteger(totalPaise)) throw new RangeError('Total exceeds the safe integer range');

  const sorted = [...groups.values()].sort((a, b) =>
    groupBy === 'category' ? b.totalPaise - a.totalPaise || a.key.localeCompare(b.key) : a.key.localeCompare(b.key),
  );
  return { totalPaise, entryCount: entries.length, groups: sorted };
}
