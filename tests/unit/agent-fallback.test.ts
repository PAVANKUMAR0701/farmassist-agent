import { describe, expect, it } from 'vitest';
import { decideFallback, FALLBACK_HELP } from '../../src/agent/fallback.js';

const TODAY = '2026-10-14';
const decide = (text: string, lastExpenseId?: string) => decideFallback(text, { lastExpenseId }, TODAY);

describe('deterministic fallback: expenses', () => {
  it.each([
    ['spent 2500 on feed', 2500, 'feed'],
    ['Paid ₹800 for medicine for the cow', 800, 'medicine'],
    ['bought diesel for Rs. 1,200', 1200, 'fuel'],
    ['labour wages 450.50', 450.5, 'labour'],
    ['hay 1,25,000 rupees', 125000, 'fodder'],
    ['seeds 300', 300, 'seed'],
  ])('"%s" -> record_expense %d %s', (text, amountRupees, category) => {
    expect(decide(text)).toEqual({ kind: 'tool', name: 'record_expense', args: { amountRupees, category, note: text } });
  });

  it('uses yesterday\'s date or an explicit date', () => {
    expect(decide('spent 100 on feed yesterday')).toMatchObject({ args: { date: '2026-10-13' } });
    expect(decide('spent 100 on feed on 2026-10-01')).toMatchObject({ args: { amountRupees: 100, date: '2026-10-01' } });
  });

  it('asks instead of guessing when the category or amount is missing', () => {
    expect(decide('spent 500')).toEqual({ kind: 'reply', text: expect.stringContaining('What was the ₹500 for?') });
    expect(decide('I bought feed')).toEqual({ kind: 'reply', text: 'How much did you spend on feed?' });
  });
});

describe('deterministic fallback: activities', () => {
  it.each([
    ['vaccinated the brown cow', 'vaccination', 'brown cow'],
    ['Milked Lakshmi this morning', 'milking', 'Lakshmi'],
    ['irrigated the north field today', 'irrigation', 'north field'],
    ['harvested wheat', 'harvesting', 'wheat'],
  ])('"%s" -> %s of %s', (text, activityType, animalOrField) => {
    expect(decide(text)).toEqual({ kind: 'tool', name: 'record_farm_activity', args: { activityType, animalOrField, note: text } });
  });
});

describe('deterministic fallback: questions', () => {
  it('spending questions default to this month and keep the category', () => {
    expect(decide('how much on feed this month')).toEqual({ kind: 'tool', name: 'get_expense_summary', args: { period: 'this_month', category: 'feed' } });
    expect(decide('total spent last month')).toEqual({ kind: 'tool', name: 'get_expense_summary', args: { period: 'last_month' } });
    expect(decide('how much did I spend')).toEqual({ kind: 'tool', name: 'get_expense_summary', args: { period: 'this_month' } });
  });

  it('daily summaries, lists and weekly insights', () => {
    expect(decide("today's summary")).toEqual({ kind: 'tool', name: 'get_daily_summary', args: {} });
    expect(decide('what happened yesterday')).toEqual({ kind: 'tool', name: 'get_daily_summary', args: { date: '2026-10-13' } });
    expect(decide('show expenses this week')).toEqual({ kind: 'tool', name: 'list_expenses', args: { period: 'this_week', limit: 20 } });
    expect(decide('weekly insights')).toEqual({ kind: 'tool', name: 'weekly_insights', args: {} });
    expect(decide('how was my week')).toEqual({ kind: 'tool', name: 'weekly_insights', args: {} });
  });
});

describe('deterministic fallback: corrections', () => {
  it('corrects the last expense of the conversation', () => {
    expect(decide('No, it was 900', 'exp_20261014_X')).toEqual({
      kind: 'tool',
      name: 'correct_entry',
      args: { entryId: 'exp_20261014_X', newAmountRupees: 900, reason: 'No, it was 900' },
    });
    expect(decide('actually it was fuel', 'exp_1')).toMatchObject({ args: { entryId: 'exp_1', newCategory: 'fuel' } });
  });

  it('asks which expense when there is none in this conversation, and never writes', () => {
    expect(decide('no, it was 900')).toMatchObject({ kind: 'reply' });
    expect(decide('no, wrong', 'exp_1')).toEqual({ kind: 'reply', text: 'What should the corrected amount or category be?' });
  });
});

it('answers anything else with help, without calling a tool', () => {
  expect(decide('hello')).toEqual({ kind: 'reply', text: FALLBACK_HELP });
  expect(decide('   ')).toEqual({ kind: 'reply', text: FALLBACK_HELP });
});
