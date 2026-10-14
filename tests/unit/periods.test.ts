import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, resolveNamedPeriod } from '../../src/shared/time.js';

describe('resolveNamedPeriod', () => {
  // 2026-10-14 is a Wednesday.
  const today = '2026-10-14';

  it.each([
    ['today', { from: '2026-10-14', to: '2026-10-14' }],
    ['yesterday', { from: '2026-10-13', to: '2026-10-13' }],
    ['this_week', { from: '2026-10-12', to: '2026-10-14' }],
    ['last_7_days', { from: '2026-10-08', to: '2026-10-14' }],
    ['this_month', { from: '2026-10-01', to: '2026-10-14' }],
    ['last_month', { from: '2026-09-01', to: '2026-09-30' }],
  ] as const)('%s', (period, expected) => {
    expect(resolveNamedPeriod(period, today)).toEqual(expected);
  });

  it('this_week starts on Monday, even when today is Monday or Sunday', () => {
    expect(resolveNamedPeriod('this_week', '2026-10-12').from).toBe('2026-10-12'); // Monday
    expect(resolveNamedPeriod('this_week', '2026-10-18').from).toBe('2026-10-12'); // Sunday
  });

  it('last_month crosses the year boundary in January', () => {
    expect(resolveNamedPeriod('last_month', '2027-01-05')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
  });

  it('last_month handles February in a leap year', () => {
    expect(resolveNamedPeriod('last_month', '2028-03-10')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
  });

  it('yesterday on the 1st is the last day of the previous month', () => {
    expect(resolveNamedPeriod('yesterday', '2026-11-01')).toEqual({ from: '2026-10-31', to: '2026-10-31' });
  });
});

describe('date arithmetic', () => {
  it('addDays and daysBetween agree across month ends', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(daysBetween('2026-01-01', '2026-12-31')).toBe(364);
  });
});
