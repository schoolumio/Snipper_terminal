import { describe, expect, it } from 'vitest';
import { age, pct, price, short, usd } from './format';

describe('display formatting', () => {
  it('formats money with explicit signs', () => {
    expect(usd('1234.5')).toBe('$1,234.50');
    expect(usd('-3.2')).toBe('−$3.20');
    expect(usd('3.2', { sign: true })).toBe('+$3.20');
    expect(usd(null)).toBe('—');
  });
  it('compresses tiny token prices with subscript zeros', () => {
    expect(price('0.00001234')).toBe('0.0₄1234');
    expect(price('0.012')).toBe('0.01200');
    expect(price('2.5')).toBe('2.5');
  });
  it('formats percentages, ages and addresses', () => {
    expect(pct('12.345', { sign: true })).toBe('+12.3%');
    expect(pct('-0.5')).toBe('−0.50%');
    expect(age(90_000)).toBe('1m');
    expect(age(3_660_000)).toBe('1h1m');
    expect(short('So11111111111111111111111111111111111111112')).toBe('So11…1112');
  });
});
