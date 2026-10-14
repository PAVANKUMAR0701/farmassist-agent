import { describe, expect, it } from 'vitest';
import { formatPaise, hasAtMostTwoDecimals, rupeesToPaise } from '../../src/shared/money.js';

describe('rupeesToPaise', () => {
  it.each([
    [2500, 250000],
    [149.5, 14950],
    [0.01, 1],
    [19.99, 1999], // 19.99 * 100 = 1998.9999999999998 in floating point
    [1.1, 110], // 1.1 * 100 = 110.00000000000001
    [10_000_000, 1_000_000_000],
  ])('converts ₹%d to %d paise', (rupees, paise) => {
    expect(rupeesToPaise(rupees)).toBe(paise);
  });

  it.each([0, -5, 1.234, Number.NaN, Number.POSITIVE_INFINITY])('rejects %d', (rupees) => {
    expect(() => rupeesToPaise(rupees)).toThrow(RangeError);
  });

  it('keeps totals exact where floating-point rupees would drift', () => {
    const rupeeAmounts = [0.1, 0.2];
    const floatTotal = rupeeAmounts.reduce((a, b) => a + b, 0);
    const paiseTotal = rupeeAmounts.map(rupeesToPaise).reduce((a, b) => a + b, 0);
    expect(floatTotal).not.toBe(0.3); // 0.30000000000000004: the bug we are avoiding
    expect(paiseTotal).toBe(30);
  });
});

describe('hasAtMostTwoDecimals', () => {
  it('accepts whole and 2-decimal amounts, rejects 3 decimals', () => {
    expect(hasAtMostTwoDecimals(100)).toBe(true);
    expect(hasAtMostTwoDecimals(99.95)).toBe(true);
    expect(hasAtMostTwoDecimals(99.955)).toBe(false);
  });
});

describe('formatPaise', () => {
  it('uses Indian digit grouping (lakhs)', () => {
    expect(formatPaise(250000)).toBe('₹2,500.00');
    expect(formatPaise(250000000)).toBe('₹25,00,000.00');
    expect(formatPaise(1)).toBe('₹0.01');
  });
});
