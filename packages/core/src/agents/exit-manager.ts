import { d, Decimal, max, pct, s } from '../decimal';
import type { MarketSnapshot, Position, PositionMark, Quote } from '../types';

export type ExitReason =
  | 'stop_loss'
  | 'trailing_stop'
  | 'break_even_stop'
  | 'take_profit'
  | 'time_stop'
  | 'momentum_reversal'
  | 'liquidity_deterioration'
  | 'risk_alert'
  | 'manual'
  | 'emergency';

export interface ExitEvalInput {
  position: Position;
  /** Executable sell quote for the full remaining quantity. */
  quote: Quote | null;
  quoteError: string | null;
  snapshot: MarketSnapshot | null;
  now: number;
}

export interface ExitEvaluation {
  mark: PositionMark;
  action: 'hold' | 'exit';
  /** Fraction (0..1] of the remaining quantity to sell. */
  fraction: Dec;
  reason: ExitReason | null;
  detail: string;
  /** Mutations to apply to the position (stops, water marks). */
  updates: Partial<Pick<Position, 'highWaterValuePerToken' | 'stopPricePerToken' | 'trailingActive' | 'breakEvenArmed'>>;
  notes: { type: 'stop_moved' | 'trailing_activated'; detail: string }[];
}

type Dec = string;

export function initialStop(costPerToken: Decimal, stopLossPct: Dec): Decimal {
  return costPerToken.times(d(1).minus(pct(stopLossPct)));
}

/**
 * Deterministic exit rules evaluated against the *executable* sell quote
 * (after price impact, swap fee and network fee) — never the mid price alone.
 * Stops are enforced by this application, not on-chain: they only act when the
 * engine is running, has a quote, and the sell transaction lands.
 */
export function evaluateExit(input: ExitEvalInput): ExitEvaluation {
  const { position: p, quote, snapshot, now } = input;
  const policy = p.exitPolicy;
  const qty = d(p.qty);
  const notes: ExitEvaluation['notes'] = [];
  const updates: ExitEvaluation['updates'] = {};

  if (!quote || qty.lte(0)) {
    return {
      mark: {
        ts: now,
        liquidationValue: null,
        markValue: snapshot ? s(qty.times(snapshot.price), 8) : null,
        midPrice: snapshot?.price ?? null,
        priceImpactPct: null,
        liquidity: snapshot?.liquidity ?? null,
        unrealizedPnl: null,
        unrealizedPnlPct: null,
        quoteError: input.quoteError ?? 'no executable quote',
      },
      action: 'hold',
      fraction: '0',
      reason: null,
      detail: `cannot evaluate exit: ${input.quoteError ?? 'no quote'}`,
      updates,
      notes,
    };
  }

  const liquidation = max(0, d(quote.expectedOut).minus(quote.networkFeeQuote));
  const valuePerToken = liquidation.div(qty);
  const costPerToken = d(p.openCostBasis).div(qty);
  const gainPct = costPerToken.gt(0) ? valuePerToken.div(costPerToken).minus(1).times(100) : d(0);
  const unrealized = liquidation.minus(p.openCostBasis);
  const mark: PositionMark = {
    ts: now,
    liquidationValue: s(liquidation, 8),
    markValue: s(qty.times(quote.midPrice), 8),
    midPrice: quote.midPrice,
    priceImpactPct: quote.priceImpactPct,
    liquidity: snapshot?.liquidity ?? null,
    unrealizedPnl: s(unrealized, 8),
    unrealizedPnlPct: s(gainPct, 4),
    quoteError: null,
  };

  // Water mark and stop maintenance.
  const high = Decimal.max(d(p.highWaterValuePerToken), valuePerToken);
  if (high.gt(p.highWaterValuePerToken)) updates.highWaterValuePerToken = s(high, 18);
  let stop = d(p.stopPricePerToken);
  let stopKind: ExitReason = p.trailingActive ? 'trailing_stop' : p.breakEvenArmed ? 'break_even_stop' : 'stop_loss';
  if (policy.breakEven.enabled && !p.breakEvenArmed && gainPct.gte(policy.breakEven.triggerGainPct)) {
    updates.breakEvenArmed = true;
    if (costPerToken.gt(stop)) {
      stop = costPerToken;
      stopKind = 'break_even_stop';
      notes.push({ type: 'stop_moved', detail: `break-even armed at +${gainPct.toFixed(1)}%: stop → cost basis` });
    }
  }
  const trailingActive = p.trailingActive || (policy.trailing.enabled && gainPct.gte(policy.trailing.activateAtGainPct));
  if (trailingActive) {
    if (!p.trailingActive) {
      updates.trailingActive = true;
      notes.push({ type: 'trailing_activated', detail: `trailing stop active at +${gainPct.toFixed(1)}% (${policy.trailing.trailPct}% trail)` });
    }
    const trail = high.times(d(1).minus(pct(policy.trailing.trailPct)));
    if (trail.gt(stop)) {
      stop = trail;
      stopKind = 'trailing_stop';
      notes.push({ type: 'stop_moved', detail: `trailing stop raised to ${trail.toSignificantDigits(6).toString()} / token` });
    }
  }
  if (!stop.eq(p.stopPricePerToken)) updates.stopPricePerToken = s(stop, 18);

  const exit = (reason: ExitReason, detail: string, fraction: Dec = '1'): ExitEvaluation => ({ mark, action: 'exit', fraction, reason, detail, updates, notes });

  if (snapshot && d(p.entryLiquidity).gt(0)) {
    const drop = d(1).minus(d(snapshot.liquidity).div(p.entryLiquidity)).times(100);
    if (drop.gte(policy.liquidityDropPct)) return exit('liquidity_deterioration', `pool liquidity down ${drop.toFixed(1)}% since entry (limit ${policy.liquidityDropPct}%)`);
  }
  if (valuePerToken.lte(stop)) {
    const label = stopKind === 'trailing_stop' ? 'trailing stop' : stopKind === 'break_even_stop' ? 'break-even stop' : `stop ${policy.stopLossPct}%`;
    return exit(stopKind, `${label} hit: executable value ${gainPct.toFixed(2)}% vs cost`);
  }
  const level = policy.takeProfit[p.tpLevelsHit];
  if (level && gainPct.gte(level.gainPct)) {
    return exit('take_profit', `take-profit ${p.tpLevelsHit + 1} at +${level.gainPct}% (now +${gainPct.toFixed(1)}%), selling ${d(level.sellFraction).times(100).toFixed(0)}%`, level.sellFraction);
  }
  const heldSec = (now - p.openedAt) / 1000;
  if (heldSec >= policy.maxHoldSec) return exit('time_stop', `time stop: held ${Math.round(heldSec / 60)}m (max ${Math.round(policy.maxHoldSec / 60)}m)`);
  if (policy.momentumReversal.enabled && snapshot && snapshot.priceChange.m5 !== null) {
    const m5 = d(snapshot.priceChange.m5);
    const { buys, sells } = snapshot.txns.m5;
    const ratio = buys > 0 ? sells / buys : sells;
    if (m5.lte(d(policy.momentumReversal.m5DropPct).neg()) && ratio >= Number(policy.momentumReversal.sellBuyRatio))
      return exit('momentum_reversal', `momentum reversal: ${m5.toFixed(1)}% in 5m with sell/buy ${ratio.toFixed(2)}`);
  }
  return { mark, action: 'hold', fraction: '0', reason: null, detail: `hold: ${gainPct.gte(0) ? '+' : ''}${gainPct.toFixed(2)}% executable`, updates, notes };
}
