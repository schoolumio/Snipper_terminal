import type { HardLimits, RiskConfig, TradingConfig } from '../config';
import { d, Decimal, max, min, pct, s } from '../decimal';
import type { Dec, RiskVerdict, SizingConstraint, SizingDecision } from '../types';

export interface PortfolioState {
  /** Mark-to-liquidation equity (cash + executable value of open positions). */
  equity: Dec;
  /** Equity at the start of the trading day (UTC). */
  dayStartEquity: Dec;
  peakEquity: Dec;
  cash: Dec;
  reserved: Dec;
  /** Cost basis of all open positions. */
  openExposure: Dec;
  /** Cost basis already held in this token. */
  tokenExposure: Dec;
  /** Cost basis held in newly launched tokens. */
  newLaunchExposure: Dec;
  openPositions: number;
  consecutiveLosses: number;
  lossCooldownUntil: number | null;
}

export interface SizingInput {
  portfolio: PortfolioState;
  trading: TradingConfig;
  risk: RiskConfig;
  hard: HardLimits;
  liquidity: Dec;
  stopLossPct: Dec;
  /** Estimated entry costs (fees + impact) as % of size. */
  estEntryCostPct: Dec;
  /** Estimated exit costs as % of size. */
  estExitCostPct: Dec;
  riskVerdict: RiskVerdict;
  isNewLaunch: boolean;
  now: number;
}

export type SizingResult = Omit<SizingDecision, 'id' | 'candidateId' | 'ts' | 'configVersion'>;

const PORTFOLIO_CONSTRAINTS = new Set(['availableCash', 'totalExposure', 'newLaunchExposure', 'dailyLossBudget', 'tokenExposure']);

export function drawdownPct(equity: Dec, peak: Dec): Decimal {
  const p = d(peak);
  if (p.lte(0)) return d(0);
  return max(0, p.minus(equity).div(p).times(100));
}

export function dailyPnlPct(equity: Dec, dayStart: Dec): Decimal {
  const ds = d(dayStart);
  if (ds.lte(0)) return d(0);
  return d(equity).minus(ds).div(ds).times(100);
}

/**
 * Position sizing. Every configured allocation is an upper bound; the final
 * size is the minimum over all limits (equity %, risk budget, absolute caps,
 * exposure caps, cash, executable liquidity and remaining daily-loss budget).
 */
export function sizePosition(input: SizingInput): SizingResult {
  const { portfolio: pf, trading, risk, hard } = input;
  const equity = d(pf.equity);
  const reasons: string[] = [];
  const available = max(0, d(pf.cash).minus(pf.reserved).minus(risk.minFeeReserveQuote));
  const downsidePct = d(input.stopLossPct).plus(input.estEntryCostPct).plus(input.estExitCostPct);

  const dd = drawdownPct(pf.equity, pf.peakEquity);
  const dailyPct = dailyPnlPct(pf.equity, pf.dayStartEquity);
  const maxDaily = min(risk.maxDailyLossPct, hard.maxDailyLossPct);
  const maxDd = min(risk.maxDrawdownPct, hard.maxDrawdownPct);
  const maxConc = Math.min(trading.maxConcurrentPositions, hard.maxConcurrentPositions);

  let portfolioBlock = false;
  if (pf.openPositions >= maxConc) {
    reasons.push(`max concurrent positions reached (${pf.openPositions}/${maxConc})`);
    portfolioBlock = true;
  }
  if (dailyPct.neg().gte(maxDaily)) {
    reasons.push(`daily loss ${dailyPct.toFixed(2)}% hit limit ${maxDaily.toFixed(2)}%`);
    portfolioBlock = true;
  }
  if (dd.gte(maxDd)) {
    reasons.push(`drawdown ${dd.toFixed(2)}% hit limit ${maxDd.toFixed(2)}%`);
    portfolioBlock = true;
  }
  if (pf.lossCooldownUntil !== null && input.now < pf.lossCooldownUntil) {
    reasons.push(`consecutive-loss cooldown active (${pf.consecutiveLosses} losses)`);
    portfolioBlock = true;
  }
  if (input.riskVerdict === 'REJECT') reasons.push('risk verdict REJECT');

  const dayStart = d(pf.dayStartEquity);
  const dailyLossBudget = max(0, dayStart.times(pct(maxDaily)).plus(d(pf.equity).minus(dayStart)));

  const c: [string, Decimal][] = [
    ['equityAllocation', equity.times(pct(min(trading.maxTradeAllocationPct, hard.maxTradeAllocationPct)))],
    ['riskBudget', downsidePct.gt(0) ? equity.times(pct(risk.riskPerTradePct)).div(pct(downsidePct)) : d(0)],
    ['maxPositionSize', min(risk.maxPositionSizeQuote, hard.maxPositionSizeQuote)],
    ['tokenExposure', max(0, equity.times(pct(risk.maxTokenExposurePct)).minus(pf.tokenExposure))],
    ['totalExposure', max(0, equity.times(pct(min(risk.maxTotalExposurePct, hard.maxTotalExposurePct))).minus(pf.openExposure))],
    ['availableCash', available],
    ['liquidityParticipation', d(input.liquidity).times(pct(risk.maxLiquidityParticipationPct))],
    ['dailyLossBudget', downsidePct.gt(0) ? dailyLossBudget.div(pct(downsidePct)) : d(0)],
  ];
  if (input.isNewLaunch) c.push(['newLaunchExposure', max(0, equity.times(pct(risk.maxNewLaunchExposurePct)).minus(pf.newLaunchExposure))]);

  let maxAllowed = c.reduce((m, [, v]) => Decimal.min(m, v), new Decimal(Infinity));
  let bindingName = c.find(([, v]) => v.eq(maxAllowed))?.[0] ?? 'none';
  let size = maxAllowed;
  if (input.riskVerdict === 'REVIEW' && risk.reviewPolicy === 'strict') {
    size = size.times(risk.reviewSizeMultiplier);
    c.push(['reviewMultiplier', size]);
    bindingName = 'reviewMultiplier';
  }
  size = max(0, size).toDecimalPlaces(2, Decimal.ROUND_DOWN);
  maxAllowed = max(0, maxAllowed).toDecimalPlaces(2, Decimal.ROUND_DOWN);

  const constraints: SizingConstraint[] = c.map(([name, v]) => ({ name, limit: s(max(0, v), 2), binding: name === bindingName }));

  if (size.lt(risk.minTradeSizeQuote)) reasons.push(`size ${size.toFixed(2)} below minimum ${risk.minTradeSizeQuote} (bound by ${bindingName})`);
  const approved = reasons.length === 0;
  const deferred = !approved && (portfolioBlock || PORTFOLIO_CONSTRAINTS.has(bindingName)) && input.riskVerdict !== 'REJECT';

  const finalSize = approved ? size : d(0);
  const estEntryCost = finalSize.times(pct(input.estEntryCostPct));
  const estExitCost = finalSize.times(pct(input.estExitCostPct));
  const estDownside = finalSize.times(pct(downsidePct));
  return {
    approved,
    deferred,
    size: s(finalSize, 2),
    maxAllowed: s(maxAllowed, 2),
    equity: s(equity, 6),
    available: s(available, 6),
    reserved: s(pf.reserved, 6),
    openExposure: s(pf.openExposure, 6),
    estEntryCost: s(estEntryCost, 6),
    estExitCost: s(estExitCost, 6),
    estDownside: s(estDownside, 6),
    remainingRiskBudget: s(max(0, dailyLossBudget.minus(estDownside)), 6),
    constraints,
    reasons,
  };
}
