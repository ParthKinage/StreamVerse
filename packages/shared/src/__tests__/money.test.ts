import { describe, expect, it } from 'vitest';
import { costForSeconds, decimalToWei, formatSTRM, formatSTRMFull, parseSTRM, splitFee, stringToWei, weiToDecimal } from '../money';

describe('parseSTRM', () => {
  it('parses whole, fractional and 18-decimal values exactly', () => {
    expect(parseSTRM('1')).toBe(10n ** 18n);
    expect(parseSTRM('0.33')).toBe(330_000_000_000_000_000n);
    expect(parseSTRM('0.000000000000000001')).toBe(1n);
    expect(parseSTRM('123456789012345678901234567890.5')).toBe(123456789012345678901234567890500000000000000000n);
  });
  it('rejects junk, negatives and excess precision', () => {
    for (const bad of ['', 'abc', '-1', '1.', '.5', '1e3', '0.0000000000000000001']) {
      expect(() => parseSTRM(bad)).toThrow(RangeError);
    }
  });
});

describe('formatSTRM', () => {
  it('truncates rather than rounds and trims zeros', () => {
    expect(formatSTRM(parseSTRM('1.23459999'))).toBe('1.2345');
    expect(formatSTRM(parseSTRM('2'))).toBe('2');
    expect(formatSTRM(0n)).toBe('0');
    expect(formatSTRM(1n)).toBe('0');
    expect(formatSTRMFull(1n)).toBe('0.000000000000000001');
  });
});

describe('costForSeconds', () => {
  const rate = parseSTRM('0.33');
  it('is exact for whole minutes and floors fractions of a wei', () => {
    expect(costForSeconds(60, rate)).toBe(rate);
    expect(costForSeconds(30, rate)).toBe(rate / 2n);
    expect(costForSeconds(1, 1n)).toBe(0n);
    expect(costForSeconds(59, 61n)).toBe(59n * 61n / 60n);
  });
  it('handles very long durations without overflow', () => {
    expect(costForSeconds(10n ** 12n, parseSTRM('5'))).toBe((10n ** 12n * parseSTRM('5')) / 60n);
  });
  it('treats negative or fractional seconds safely', () => {
    expect(costForSeconds(-5, rate)).toBe(0n);
    expect(costForSeconds(59.9, 60n)).toBe(59n);
  });
});

describe('splitFee', () => {
  it('splits 10% and conserves the total', () => {
    const { fee, creator } = splitFee(1001n, 1000);
    expect(fee).toBe(100n);
    expect(fee + creator).toBe(1001n);
  });
  it('rejects bad fee values', () => {
    expect(() => splitFee(1n, 10_001)).toThrow(RangeError);
  });
});

describe('decimal conversions', () => {
  it('round-trips wei and Decimal(38,18) strings', () => {
    const wei = parseSTRM('98765.123456789012345678');
    expect(decimalToWei(weiToDecimal(wei))).toBe(wei);
    expect(weiToDecimal(1500000000000000000n)).toBe('1.500000000000000000');
    expect(decimalToWei('5')).toBe(5n * 10n ** 18n);
    expect(decimalToWei('0.330000000000000000')).toBe(330_000_000_000_000_000n);
  });
  it('validates wei strings', () => {
    expect(stringToWei('42')).toBe(42n);
    expect(() => stringToWei('4.2')).toThrow(RangeError);
  });
});
