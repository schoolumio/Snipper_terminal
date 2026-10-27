import { d, Decimal, max, s } from '../decimal';
import type { Dec, EquitySnapshot, Ledger, PerformanceStats, Position, Trade, TradingMode } from '../types';
import { newId } from '../util/ids';
import { dayKey } from '../util/time';
import { drawdownPct } from './sizer';

/**
 * Portfolio accounting. All functions return new ledger objects; callers
 * persist them atomically together with the order / position change that
 * caused them. Deposits and withdrawals never touch realized P&L.
 */

export function newLedger(mode: TradingMode, startingEquity: Dec, now: number, currency = 'USDC'): Ledger {
  return {
    mode,
    currency,
    startingEquity: s(startingEquity, 8),
    cash: s(startingEquity, 8),
    reserved: '0',
    deposits: '0',
    withdrawals: '0',
    realizedPnl: '0',
    feesPaid: '0',
    peakEquity: s(startingEquity, 8),
    dayStartEquity: s(startingEquity, 8),
    dayKey: dayKey(now),
    updatedAt: now,
  };
}

export function reserve(l: Ledger, amount: Dec, now: number): Ledger {
  const available = d(l.cash).minus(l.reserved);
  if (d(amount).gt(available)) throw new Error(`cannot reserve ${amount}: only ${available.toFixed()} available`);
  return { ...l, reserved: s(d(l.reserved).plus(amount), 8), updatedAt: now };
}

export function release(l: Ledger, amount: Dec, now: number): Ledger {
  return { ...l, reserved: s(max(0, d(l.reserved).minus(amount)), 8), updatedAt: now };
}

export function applyEntryFill(l: Ledger, amountIn: Dec, networkFee: Dec, now: number): Ledger {
  const cash = d(l.cash).minus(amountIn).minus(networkFee);
  if (cash.lt(0)) throw new Error('entry fill would make cash negative');
  return { ...l, cash: s(cash, 8), feesPaid: s(d(l.feesPaid).plus(networkFee), 8), updatedAt: now };
}

/** A failed transaction still costs its network fee — a realized trading loss. */
export function applyFailedTx(l: Ledger, networkFee: Dec, now: number): Ledger {
  return {
    ...l,
    cash: s(d(l.cash).minus(networkFee), 8),
    feesPaid: s(d(l.feesPaid).plus(networkFee), 8),
    realizedPnl: s(d(l.realizedPnl).minus(networkFee), 8),
    updatedAt: now,
  };
}

export function applyExitFill(l: Ledger, proceeds: Dec, networkFee: Dec, costBasisPortion: Dec, now: number): Ledger {
  const net = d(proceeds).minus(networkFee);
  return {
    ...l,
    cash: s(d(l.cash).plus(net), 8),
    feesPaid: s(d(l.feesPaid).plus(networkFee), 8),
    realizedPnl: s(d(l.realizedPnl).plus(net.minus(costBasisPortion)), 8),
    updatedAt: now,
  };
}

/** Write a position off (e.g. permanently unsellable). Cost basis becomes realized loss. */
export function applyWriteOff(l: Ledger, costBasisPortion: Dec, now: number): Ledger {
  return { ...l, realizedPnl: s(d(l.realizedPnl).minus(costBasisPortion), 8), updatedAt: now };
}

export function applyDeposit(l: Ledger, amount: Dec, now: number): Ledger {
  const a = d(amount);
  if (a.lte(0)) throw new Error('deposit must be positive');
  return {
    ...l,
    cash: s(d(l.cash).plus(a), 8),
    deposits: s(d(l.deposits).plus(a), 8),
    peakEquity: s(d(l.peakEquity).plus(a), 8),
    dayStartEquity: s(d(l.dayStartEquity).plus(a), 8),
    updatedAt: now,
  };
}

export function applyWithdrawal(l: Ledger, amount: Dec, now: number): Ledger {
  const a = d(amount);
  if (a.lte(0)) throw new Error('withdrawal must be positive');
  if (a.gt(d(l.cash).minus(l.reserved))) throw new Error('withdrawal exceeds available cash');
  return {
    ...l,
    cash: s(d(l.cash).minus(a), 8),
    withdrawals: s(d(l.withdrawals).plus(a), 8),
    peakEquity: s(max(0, d(l.peakEquity).minus(a)), 8),
    dayStartEquity: s(max(0, d(l.dayStartEquity).minus(a)), 8),
    updatedAt: now,
  };
}

export interface Valuation {
  equity: Decimal;
  openLiquidation: Decimal;
  openMark: Decimal;
  openCost: Decimal;
  unrealized: Decimal;
  unvalued: number;
}

/**
 * Equity = cash + executable (liquidation) value of open positions.
 * Positions without a reliable quote, or flagged unsellable, count as zero.
 */
export function valuePortfolio(l: Ledger, positions: Position[]): Valuation {
  let liq = d(0);
  let mark = d(0);
  let cost = d(0);
  let unvalued = 0;
  for (const p of positions) {
    if (p.mode !== l.mode || p.status === 'closed' || p.status === 'failed' || p.status === 'pending') continue;
    cost = cost.plus(p.openCostBasis);
    const lv = p.lastMark?.liquidationValue;
    if (p.unsellable || lv === null || lv === undefined) unvalued++;
    else liq = liq.plus(lv);
    if (p.lastMark?.markValue) mark = mark.plus(p.lastMark.markValue);
  }
  return { equity: d(l.cash).plus(liq), openLiquidation: liq, openMark: mark, openCost: cost, unrealized: liq.minus(cost), unvalued };
}

/** Roll the trading day and raise the equity peak. */
export function touchLedger(l: Ledger, equity: Decimal, now: number): Ledger {
  const k = dayKey(now);
  const next = { ...l };
  if (k !== l.dayKey) {
    next.dayKey = k;
    next.dayStartEquity = s(equity, 8);
  }
  if (equity.gt(l.peakEquity)) next.peakEquity = s(equity, 8);
  return next;
}

export function equitySnapshot(l: Ledger, positions: Position[], now: number): EquitySnapshot {
  const v = valuePortfolio(l, positions);
  return {
    id: newId('eq', now),
    mode: l.mode,
    ts: now,
    equity: s(v.equity, 8),
    cash: l.cash,
    reserved: l.reserved,
    openLiquidationValue: s(v.openLiquidation, 8),
    openMarkValue: s(v.openMark, 8),
    realizedPnl: l.realizedPnl,
    unrealizedPnl: s(v.unrealized, 8),
    drawdownPct: s(drawdownPct(s(v.equity, 8), Decimal.max(d(l.peakEquity), v.equity).toFixed()), 4),
    openPositions: positions.filter((p) => p.mode === l.mode && (p.status === 'open' || p.status === 'exit_pending' || p.status === 'reconciliation_required')).length,
    unvaluedPositions: v.unvalued,
  };
}

export function computePerformance(
  l: Ledger,
  positions: Position[],
  trades: Trade[],
  equity: EquitySnapshot[],
  tx: { submitted: number; failed: number },
): PerformanceStats {
  const v = valuePortfolio(l, positions);
  const mine = trades.filter((t) => t.mode === l.mode);
  const wins = mine.filter((t) => d(t.netPnl).gt(0));
  const losses = mine.filter((t) => d(t.netPnl).lte(0));
  const sum = (xs: Trade[], f: (t: Trade) => Dec) => xs.reduce((a, t) => a.plus(f(t)), d(0));
  const grossProfit = sum(wins, (t) => t.netPnl);
  const grossLoss = sum(losses, (t) => t.netPnl);
  let peak = d(l.startingEquity);
  let maxDd = d(0);
  for (const e of equity) {
    if (e.mode !== l.mode) continue;
    if (d(e.equity).gt(peak)) peak = d(e.equity);
    const dd = drawdownPct(e.equity, s(peak, 8));
    if (dd.gt(maxDd)) maxDd = dd;
  }
  const curPeak = Decimal.max(d(l.peakEquity), v.equity);
  const curDd = drawdownPct(s(v.equity, 8), s(curPeak, 8));
  if (curDd.gt(maxDd)) maxDd = curDd;
  const byStrategy: PerformanceStats['byStrategy'] = {};
  for (const t of mine) {
    const b = (byStrategy[t.strategy] ??= { trades: 0, wins: 0, netPnl: '0' });
    b.trades++;
    if (d(t.netPnl).gt(0)) b.wins++;
    b.netPnl = s(d(b.netPnl).plus(t.netPnl), 8);
  }
  const net = v.equity.minus(l.startingEquity).minus(l.deposits).plus(l.withdrawals);
  return {
    mode: l.mode,
    startingEquity: l.startingEquity,
    equity: s(v.equity, 8),
    available: s(max(0, d(l.cash).minus(l.reserved)), 8),
    reserved: l.reserved,
    realizedPnl: l.realizedPnl,
    unrealizedPnl: s(v.unrealized, 8),
    grossProfit: s(grossProfit, 8),
    grossLoss: s(grossLoss, 8),
    feesPaid: l.feesPaid,
    netPnl: s(net, 8),
    dailyPnl: s(v.equity.minus(l.dayStartEquity), 8),
    trades: mine.length,
    wins: wins.length,
    losses: losses.length,
    winRate: mine.length ? wins.length / mine.length : null,
    avgWin: wins.length ? s(grossProfit.div(wins.length), 8) : null,
    avgLoss: losses.length ? s(grossLoss.div(losses.length), 8) : null,
    profitFactor: grossLoss.isZero() ? null : grossProfit.div(grossLoss.abs()).toNumber(),
    avgHoldSec: mine.length ? Math.round(mine.reduce((a, t) => a + t.holdSec, 0) / mine.length) : null,
    avgSlippagePct: mine.length ? s(sum(mine, (t) => t.slippagePct).div(mine.length), 4) : null,
    maxDrawdownPct: s(maxDd, 4),
    currentDrawdownPct: s(curDd, 4),
    openPositions: positions.filter((p) => p.mode === l.mode && ['open', 'exit_pending', 'reconciliation_required'].includes(p.status)).length,
    openExposure: s(v.openCost, 8),
    unvaluedPositions: v.unvalued,
    failedTxRate: tx.submitted ? tx.failed / tx.submitted : null,
    byStrategy,
  };
}
