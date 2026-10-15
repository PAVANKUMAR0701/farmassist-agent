import { describe, expect, it } from 'vitest';
import { checkNumbers, extractNumericClaims } from '../../src/domain/number-guard.js';
import { computeWeeklyFacts, templateNarrative, type WeeklyFacts } from '../../src/domain/weekly-facts.js';
import type { ExpenseEntry } from '../../src/domain/expense.js';
import type { FarmActivity } from '../../src/domain/activity.js';

const exp = (amountPaise: number, category: ExpenseEntry['category'], date: string, i: number): ExpenseEntry => ({
  entryId: `exp_${date.replaceAll('-', '')}_${String(i).padStart(26, '0')}`,
  farmId: 'f',
  date,
  category,
  amountPaise,
  createdAt: '',
  updatedAt: '',
  version: 1,
});
const act = (activityType: FarmActivity['activityType'], i: number): FarmActivity => ({
  entryId: `act_20261014_${String(i).padStart(26, '0')}`,
  farmId: 'f',
  date: '2026-10-14',
  activityType,
  createdAt: '',
  updatedAt: '',
  version: 1,
});

const week = { from: '2026-10-08', to: '2026-10-14' };
const previousWeek = { from: '2026-10-01', to: '2026-10-07' };

// This week: feed 2500 + 150.25, medicine 900 = ₹3,550.25. Previous week: feed 2,000.
function sampleFacts(): WeeklyFacts {
  return computeWeeklyFacts({
    week,
    previousWeek,
    dayCount: 7,
    expenses: [exp(250000, 'feed', '2026-10-14', 1), exp(90000, 'medicine', '2026-10-14', 2), exp(15025, 'feed', '2026-10-10', 3)],
    previousExpenses: [exp(200000, 'feed', '2026-10-03', 4)],
    activities: [act('milking', 5), act('milking', 6), act('milking', 7), act('vaccination', 8)],
  });
}

describe('computeWeeklyFacts', () => {
  it('calculates totals, shares and the week-on-week change in code', () => {
    const facts = sampleFacts();
    expect(facts).toMatchObject({
      totalPaise: 355025,
      totalDisplay: '₹3,550.25',
      expenseCount: 3,
      topCategory: 'feed',
      previousTotalPaise: 200000,
      // 355025 - 200000 = 155025 -> ₹1,550.25, which is 77.5125% of ₹2,000 -> 78%
      change: { direction: 'up', differencePaise: 155025, differenceDisplay: '₹1,550.25', changePercent: 78 },
      activityCount: 4,
      activities: [
        { activityType: 'milking', activityCount: 3 },
        { activityType: 'vaccination', activityCount: 1 },
      ],
      sufficientData: true,
    });
    // feed 265025 / 355025 = 74.65% -> 75; medicine 90000 / 355025 = 25.35% -> 25
    expect(facts.byCategory).toEqual([
      { category: 'feed', totalPaise: 265025, totalDisplay: '₹2,650.25', entryCount: 2, sharePercent: 75 },
      { category: 'medicine', totalPaise: 90000, totalDisplay: '₹900.00', entryCount: 1, sharePercent: 25 },
    ]);
  });

  it('leaves out the change when the previous week is empty, and flags too little data', () => {
    const facts = computeWeeklyFacts({ week, previousWeek, dayCount: 7, expenses: [exp(5000, 'fuel', '2026-10-12', 1)], previousExpenses: [], activities: [] });
    expect(facts.change).toBeUndefined();
    expect(facts.sufficientData).toBe(false);
  });
});

describe('number guard', () => {
  it('accepts narration that only uses numbers from the facts', () => {
    const text =
      'This week you spent ₹3,550.25 over 3 expenses. Feed took ₹2,650.25, about 75% of the total, and medicine ₹900. ' +
      'Spending rose by ₹1,550.25 (78%) compared with the previous 7 days. You milked three times.';
    const result = checkNumbers(text, sampleFacts());
    expect(result.unsupported).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('accepts whole-rupee rounding of a real amount', () => {
    expect(checkNumbers('You spent about ₹3,550 this week.', sampleFacts()).ok).toBe(true);
  });

  it('rejects an invented total', () => {
    const result = checkNumbers('This week you spent ₹4,000 on feed.', sampleFacts());
    expect(result.ok).toBe(false);
    expect(result.unsupported).toEqual(['₹4,000']);
  });

  it('rejects a made-up percentage and a real number used with the wrong unit', () => {
    // 3 is a count, not a percentage; 75 is a percentage, not rupees.
    expect(checkNumbers('Feed rose 12% this week.', sampleFacts()).unsupported).toEqual(['12%']);
    expect(checkNumbers('Costs went up 3%.', sampleFacts()).unsupported).toEqual(['3%']);
    expect(checkNumbers('Feed cost ₹75.', sampleFacts()).unsupported).toEqual(['₹75']);
  });

  it('rejects a projection the model calculated itself', () => {
    // ₹3,550.25 x 4 weeks = ₹14,201 — arithmetic done by the model, not by code.
    expect(checkNumbers('At this rate you will spend ₹14,201 this month.', sampleFacts()).ok).toBe(false);
  });

  it('rejects dates that are not in the facts and magnitude words', () => {
    expect(checkNumbers('Since 2026-09-01 costs went up.', sampleFacts()).unsupported).toEqual(['2026-09-01']);
    // "two" is a real count here (feed has 2 entries); the magnitude word is what gets rejected.
    expect(checkNumbers('You spent over two thousand rupees on feed.', sampleFacts()).unsupported).toEqual(['thousand']);
    expect(checkNumbers('Between 2026-10-08 and 2026-10-14 you spent ₹3,550.25.', sampleFacts()).ok).toBe(true);
  });

  it('reads Rs, INR and "rupees" forms and Indian digit grouping', () => {
    const claims = extractNumericClaims('Rs. 1,00,000 then INR 900 and 2,650.25 rupees, up 78 percent');
    expect(claims.map((c) => [c.kind, c.value])).toEqual([
      ['money', 100000],
      ['money', 900],
      ['money', 2650.25],
      ['percent', 78],
    ]);
  });

  it('accepts the template narrative it falls back to', () => {
    const facts = sampleFacts();
    const text = templateNarrative(facts);
    expect(text).toBe(
      'From 2026-10-08 to 2026-10-14 you spent ₹3,550.25 across 3 expenses. The most went on feed: ₹2,650.25, 75% of the week\'s spending. ' +
        'That is ₹1,550.25 (78%) more than the previous 7 days (₹2,000.00). Farm activities recorded: milking 3 times, vaccination once.',
    );
    expect(checkNumbers(text, facts).ok).toBe(true);
  });

  it('template narratives pass the guard for empty and thin weeks too', () => {
    for (const expenses of [[], [exp(5000, 'fuel', '2026-10-12', 1)]]) {
      const facts = computeWeeklyFacts({ week, previousWeek, dayCount: 7, expenses, previousExpenses: [], activities: [] });
      expect(checkNumbers(templateNarrative(facts), facts).ok).toBe(true);
    }
  });
});
