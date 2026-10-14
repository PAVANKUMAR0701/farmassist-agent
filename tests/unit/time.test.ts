import { describe, expect, it } from 'vitest';
import { todayInFarmTimeZone } from '../../src/shared/time.js';

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
