import { describe, expect, it } from 'vitest';
import { afterEach } from 'vitest';
import { formatCountdown, formatDuration, money, moneyTitle, priceLabel, setMoneyFormat, shortAddress, strm, strmTitle, toBig } from './format';

describe('format helpers', () => {
  it('shows STRM with up to 4 decimals and the full value for hover', () => {
    expect(strm('1234567890123456789')).toBe('1.2345');
    expect(strm('1000000000000000000')).toBe('1');
    expect(strm('0')).toBe('0');
    expect(strmTitle('1234567890123456789')).toBe('1.234567890123456789 STRM');
  });
  it('never turns bad input into NaN', () => {
    expect(toBig('abc')).toBe(0n);
    expect(toBig(null)).toBe(0n);
    expect(strm('-5')).toBe('0');
  });
  it('formats durations and countdowns', () => {
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(3725)).toBe('1:02:05');
    expect(formatCountdown(0)).toBe('now');
    expect(formatCountdown(61_000)).toBe('1:01');
  });
  it('labels free and paid prices and shortens addresses', () => {
    expect(priceLabel('0')).toBe('Free');
    expect(priceLabel('20000000000000000000')).toBe('20 STRM');
    expect(shortAddress('0x1234567890abcdef1234567890abcdef12345678')).toBe('0x1234…5678');
  });
});

describe('money display', () => {
  afterEach(() => setMoneyFormat({ mode: 'chain', symbol: '', code: 'STRM' }));
  it('shows STRM amounts in chain mode', () => {
    expect(money('1500000000000000000')).toBe('1.5 STRM');
    expect(priceLabel('600000000000000000')).toBe('0.6 STRM');
  });
  it('shows rupees in bank mode, at least two decimals', () => {
    setMoneyFormat({ mode: 'bank', symbol: '₹', code: 'INR' });
    expect(money('500000000000000000000')).toBe('₹500.00');
    expect(money('1234500000000000000')).toBe('₹1.2345');
    expect(money('0')).toBe('₹0.00');
    expect(priceLabel('20000000000000000000')).toBe('₹20.00');
    expect(moneyTitle('1234567890123456789')).toBe('₹1.234567890123456789');
  });
});
