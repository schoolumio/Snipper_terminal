import DecimalJs from 'decimal.js';
import type { Dec } from './types';

/**
 * Decimal arithmetic for every authoritative money / quantity calculation.
 * Values cross module, network and database boundaries as strings (`Dec`)
 * and are converted to Decimal only where arithmetic happens.
 */
export const Decimal = DecimalJs.clone({ precision: 40, rounding: DecimalJs.ROUND_HALF_EVEN, toExpNeg: -30, toExpPos: 40 });
export type Decimal = InstanceType<typeof Decimal>;

export type DecInput = Dec | number | Decimal;

export function d(v: DecInput | null | undefined): Decimal {
  if (v === null || v === undefined || v === '') return new Decimal(0);
  return new Decimal(v);
}

/** Serialize with a bounded number of decimals (no exponent notation). */
export function s(v: DecInput, dp = 18): Dec {
  const x = d(v);
  if (!x.isFinite()) throw new Error(`non-finite decimal: ${x.toString()}`);
  return x.toDecimalPlaces(dp, Decimal.ROUND_HALF_EVEN).toFixed();
}

export const ZERO: Dec = '0';

export function min(...xs: DecInput[]): Decimal {
  return Decimal.min(...xs.map(d));
}
export function max(...xs: DecInput[]): Decimal {
  return Decimal.max(...xs.map(d));
}

/** pct("2.5") -> 0.025 */
export function pct(p: DecInput): Decimal {
  return d(p).div(100);
}

/** Percentage change from a to b, in percent. Returns 0 when a is zero. */
export function pctChange(a: DecInput, b: DecInput): Decimal {
  const da = d(a);
  if (da.isZero()) return new Decimal(0);
  return d(b).minus(da).div(da).times(100);
}

export function isDec(v: unknown): v is Dec {
  if (typeof v !== 'string' || v.trim() === '') return false;
  try {
    return new Decimal(v).isFinite();
  } catch {
    return false;
  }
}

/** Lossy conversion for display / scoring only — never for balances. */
export function num(v: DecInput | null | undefined): number {
  return d(v).toNumber();
}
