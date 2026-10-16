import { describe, expect, it } from 'vitest';
import { checkMeaning } from '../../src/domain/meaning-guard.js';
import { computeWeeklyFacts } from '../../src/domain/weekly-facts.js';
import type { ExpenseCategory, ExpenseEntry } from '../../src/domain/expense.js';

let n = 0;
const e = (date: string, category: ExpenseCategory, rupees: number): ExpenseEntry => ({
  entryId: `exp_${date.replaceAll('-', '')}_01J${String(++n).padStart(23, '0')}`,
  farmId: 'f',
  date,
  category,
  amountPaise: rupees * 100,
  createdAt: '',
  updatedAt: '',
  version: 1,
});
const facts = (expenses: ExpenseEntry[], previous: ExpenseEntry[]) =>
  computeWeeklyFacts({ week: { from: '2026-10-10', to: '2026-10-16' }, previousWeek: { from: '2026-10-03', to: '2026-10-09' }, dayCount: 7, expenses, previousExpenses: previous, activities: [] });

const bigPurchase = facts([e('2026-10-14', 'equipment', 85000), e('2026-10-15', 'fuel', 450)], [e('2026-10-07', 'fuel', 500)]);
const feedWeek = facts([e('2026-10-11', 'feed', 2500), e('2026-10-13', 'feed', 1800), e('2026-10-14', 'medicine', 650)], [e('2026-10-05', 'feed', 2200)]);
const mixed = facts([e('2026-10-10', 'fuel', 1200), e('2026-10-12', 'labour', 900), e('2026-10-15', 'seed', 300)], [e('2026-10-04', 'feed', 6000)]);
const firstWeek = facts([e('2026-10-11', 'fodder', 700), e('2026-10-16', 'feed', 2400)], []);

describe('meaning guard: drafts that passed the number guard but were wrong (narration-eval, 2026-10-17)', () => {
  it.each([
    ['the week total given as the equipment amount', 'This week, your farm spent ₹85,450 on equipment and ₹450 on fuel.', bigPurchase],
    ['a sum the model worked out itself', 'Fuel was the largest at ₹1,200.00. Labour and seeds together cost ₹1,200.00.', mixed],
    ['the overall change given as a category change', "This week's spending on feed was 125% higher than last week.", feedWeek],
    ['denying a comparison that exists', "Feed made up 87% of this week's expenses. There's no earlier week to compare with.", feedWeek],
    ['comparing with a week that has no records', 'You spent ₹3,100.00, which is more than last week.', firstWeek],
    ['the wrong direction', 'Compared to last week, your spending went down.', feedWeek],
    ['claiming too few records when there are enough', 'Feed made up 87% of the spending. There are too few records to see a pattern yet.', feedWeek],
  ])('rejects %s', (_label, text, f) => {
    expect(checkMeaning(text, f).ok).toBe(false);
  });

  it.each([
    ['amounts and shares bound to the right categories', 'This week, you spent ₹4,950.00, which is ₹2,750.00 more than last week. Most of the money, ₹4,300.00, went to feed. Feed made up 87% of the spending.', feedWeek],
    ['a big purchase described correctly', 'This week, your farm spent ₹85,450.00. Most of it, ₹85,000.00, was spent on equipment, 99% of the total.', bigPurchase],
    ['no earlier week, said correctly', 'You spent ₹3,100.00. Feed made up 77% at ₹2,400.00. There is no earlier week to compare with.', firstWeek],
    // False positives seen in narration-eval: the next amount after "and" belongs to the next category.
    ['two categories joined by "and"', 'You spent ₹3,100.00, with ₹2,400.00 on feed and ₹700.00 on fodder.', firstWeek],
    ['a purchase then a small cost', 'Most of it, ₹85,000.00, went to equipment and ₹450.00 to fuel.', bigPurchase],
  ])('accepts %s', (_label, text, f) => {
    expect(checkMeaning(text, f)).toEqual({ ok: true, problems: [] });
  });
});

it('the template fallback always passes the meaning guard', async () => {
  const { templateNarrative } = await import('../../src/domain/weekly-facts.js');
  for (const f of [bigPurchase, feedWeek, mixed, firstWeek]) expect(checkMeaning(templateNarrative(f), f)).toEqual({ ok: true, problems: [] });
});
