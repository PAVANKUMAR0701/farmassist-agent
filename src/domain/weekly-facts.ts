import type { ActivityType, FarmActivity } from './activity.js';
import type { ExpenseEntry } from './expense.js';
import { summarizeExpenses } from './expense-summary.js';
import { formatPaise } from '../shared/money.js';

/** Below this many expenses in the week there is nothing meaningful to explain, so no narration is generated. */
export const MIN_EXPENSES_FOR_INSIGHT = 2;

/**
 * Every number the weekly insight may mention, calculated here in code.
 * Field-name suffixes matter: the number guard treats `*Paise` as money, `*Percent` as percentages
 * and `*Count` as counts (see number-guard.ts).
 */
export interface WeeklyFacts {
  week: { from: string; to: string };
  previousWeek: { from: string; to: string };
  dayCount: number;
  totalPaise: number;
  totalDisplay: string;
  expenseCount: number;
  byCategory: Array<{ category: string; totalPaise: number; totalDisplay: string; entryCount: number; sharePercent: number }>;
  topCategory?: string;
  previousTotalPaise: number;
  previousTotalDisplay: string;
  previousExpenseCount: number;
  /** Present only when the previous week has expenses to compare against. */
  change?: { direction: 'up' | 'down' | 'same'; differencePaise: number; differenceDisplay: string; changePercent: number };
  activityCount: number;
  activities: Array<{ activityType: ActivityType; activityCount: number }>;
  sufficientData: boolean;
}

/** Whole-number percentage, rounded half up. Shares may not add up to exactly 100 because each is rounded. */
const percentOf = (part: number, whole: number) => Math.round((part * 100) / whole);

export function computeWeeklyFacts(input: {
  week: { from: string; to: string };
  previousWeek: { from: string; to: string };
  dayCount: number;
  expenses: readonly ExpenseEntry[];
  previousExpenses: readonly ExpenseEntry[];
  activities: readonly FarmActivity[];
}): WeeklyFacts {
  const current = summarizeExpenses(input.expenses, 'category');
  const previous = summarizeExpenses(input.previousExpenses, 'category');

  const byCategory = current.groups.map((g) => ({
    category: g.key,
    totalPaise: g.totalPaise,
    totalDisplay: formatPaise(g.totalPaise),
    entryCount: g.entryCount,
    sharePercent: current.totalPaise > 0 ? percentOf(g.totalPaise, current.totalPaise) : 0,
  }));

  let change: WeeklyFacts['change'];
  if (previous.entryCount > 0 && previous.totalPaise > 0) {
    const difference = current.totalPaise - previous.totalPaise;
    change = {
      direction: difference > 0 ? 'up' : difference < 0 ? 'down' : 'same',
      differencePaise: Math.abs(difference),
      differenceDisplay: formatPaise(Math.abs(difference)),
      changePercent: percentOf(Math.abs(difference), previous.totalPaise),
    };
  }

  const activityCounts = new Map<ActivityType, number>();
  for (const a of input.activities) activityCounts.set(a.activityType, (activityCounts.get(a.activityType) ?? 0) + 1);

  return {
    week: input.week,
    previousWeek: input.previousWeek,
    dayCount: input.dayCount,
    totalPaise: current.totalPaise,
    totalDisplay: formatPaise(current.totalPaise),
    expenseCount: current.entryCount,
    byCategory,
    ...(byCategory[0] ? { topCategory: byCategory[0].category } : {}),
    previousTotalPaise: previous.totalPaise,
    previousTotalDisplay: formatPaise(previous.totalPaise),
    previousExpenseCount: previous.entryCount,
    ...(change ? { change } : {}),
    activityCount: input.activities.length,
    activities: [...activityCounts.entries()]
      .map(([activityType, activityCount]) => ({ activityType, activityCount }))
      .sort((a, b) => b.activityCount - a.activityCount || a.activityType.localeCompare(b.activityType)),
    sufficientData: current.entryCount >= MIN_EXPENSES_FOR_INSIGHT,
  };
}

/**
 * Plain narration built only from the facts. Used when there is too little data, when Bedrock is not
 * configured or unavailable, and when every Bedrock draft fails the number guard.
 */
export function templateNarrative(facts: WeeklyFacts): string {
  const { week } = facts;
  if (facts.expenseCount === 0) {
    return `No expenses were recorded from ${week.from} to ${week.to}, so there is nothing to summarise yet.`;
  }
  const sentences: string[] = [];
  const expenses = facts.expenseCount === 1 ? '1 expense' : `${facts.expenseCount} expenses`;
  sentences.push(`From ${week.from} to ${week.to} you spent ${facts.totalDisplay} across ${expenses}.`);

  const top = facts.byCategory[0];
  if (top && facts.byCategory.length > 1) {
    sentences.push(`The most went on ${top.category}: ${top.totalDisplay}, ${top.sharePercent}% of the week's spending.`);
  } else if (top) {
    sentences.push(`All of it was on ${top.category}.`);
  }

  if (!facts.sufficientData) {
    sentences.push('That is too few records to describe a pattern yet.');
  } else if (facts.change) {
    const { direction, differenceDisplay, changePercent } = facts.change;
    sentences.push(
      direction === 'same'
        ? `That is the same as the previous ${facts.dayCount} days (${facts.previousTotalDisplay}).`
        : `That is ${differenceDisplay} (${changePercent}%) ${direction === 'up' ? 'more' : 'less'} than the previous ${facts.dayCount} days (${facts.previousTotalDisplay}).`,
    );
  } else {
    sentences.push(`No expenses were recorded in the previous ${facts.dayCount} days, so there is nothing to compare with.`);
  }

  if (facts.activityCount > 0) {
    const list = facts.activities.map((a) => `${a.activityType} ${a.activityCount === 1 ? 'once' : `${a.activityCount} times`}`).join(', ');
    sentences.push(`Farm activities recorded: ${list}.`);
  }
  return sentences.join(' ');
}
