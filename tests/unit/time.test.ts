import { describe, expect, it } from 'vitest';
import { isValidIsoDate, todayInFarmTimeZone } from '../../src/shared/time.js';

describe('todayInFarmTimeZone (Asia/Kolkata, UTC+05:30)', () => {
  it('is still the same IST day one second before IST midnight', () => {
    expect(todayInFarmTimeZone(new Date('2026-10-14T18:29:59Z'))).toBe('2026-10-14');
  });

  it('rolls over to the next IST day at 18:30 UTC, while UTC is still on the previous day', () => {
    expect(todayInFarmTimeZone(new Date('2026-10-14T18:30:00Z'))).toBe('2026-10-15');
  });

  it('handles month and year boundaries', () => {
    expect(todayInFarmTimeZone(new Date('2026-12-31T19:00:00Z'))).toBe('2027-01-01');
  });
});

describe('isValidIsoDate', () => {
  it.each(['2026-10-14', '2028-02-29', '2026-01-01'])('accepts %s', (d) => expect(isValidIsoDate(d)).toBe(true));
  it.each(['2026-02-29', '2026-02-30', '2026-13-01', '2026-1-5', '14-10-2026', '2026-10-14T00:00', ''])('rejects %s', (d) =>
    expect(isValidIsoDate(d)).toBe(false),
  );
});
