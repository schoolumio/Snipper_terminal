import { describe, expect, it } from 'vitest';
import { applyDeposit, applyEntryFill, applyExitFill, applyFailedTx, applyWithdrawal, computePerformance, newLedger, reserve, valuePortfolio } from '../src/agents/accountant';
import { entryPreTradeChecks, type EntryCheckInput } from '../src/agents/executor-checks';
import { evaluateExit } from '../src/agents/exit-manager';
import { evaluateRisk } from '../src/agents/risk-guard';
import { sizePosition, type SizingInput } from '../src/agents/sizer';
import { redact } from '../src/agents/audit-logger';
import { checkHardLimits, DEFAULT_CONFIG, DEFAULT_EXIT_POLICY, DEFAULT_HARD_LIMITS, EngineConfigSchema } from '../src/config';
import { d, pctChange, s } from '../src/decimal';
import { mergeSecurityReports } from '../src/market/providers';
import { ammQuote } from '../src/market/sim/simulated-market';
import { canTransition, InvalidTransitionError, transition } from '../src/state-machine';
import { STRATEGIES } from '../src/strategies';
import type { Candidate, MarketSnapshot, Position, Quote, SecurityReport, Trade, TradeProposal } from '../src/types';
import { T0 } from './fixtures';

const cfg = structuredClone(DEFAULT_CONFIG);

function snap(over: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    chain: 'simnet',
    poolAddress: 'P',
    tokenAddress: 'T',
    ts: T0,
    fetchedAt: T0,
    source: 'test',
    price: '0.001',
    liquidity: '40000',
    marketCap: '400000',
    volume: { m1: '1200', m5: '5000', h1: '9000' },
    txns: { m5: { buys: 40, sells: 20 }, h1: { buys: 80, sells: 40 } },
    priceChange: { m1: '1', m5: '10', h1: null },
    holders: 200,
    uniqueTraders5m: 40,
    ...over,
  };
}

function report(over: Partial<SecurityReport> = {}): SecurityReport {
  return {
    chain: 'simnet',
    tokenAddress: 'T',
    source: 'test',
    fetchedAt: T0,
    mintAuthorityRenounced: true,
    freezeAuthorityRenounced: true,
    top10HolderPct: '20',
    creatorHoldingPct: '2',
    holderCount: 200,
    lpLock: { claimed: true, verified: true, lockedPct: '100', unlockAt: null, evidence: 'x' },
    sellSimulationOk: true,
    transferTaxPct: '0',
    creatorPriorFlaggedTokens: 0,
    knownMalicious: false,
    providerFlags: [],
    ...over,
  };
}

function quote(side: 'buy' | 'sell', amountIn: string, rt = 20_000_000, rq = 20_000, now = T0): Quote {
  return { id: 'q', chain: 'simnet', poolAddress: 'P', tokenAddress: 'T', side, amountIn, ...ammQuote(rt, rq, 0.0025, side, amountIn), networkFeeQuote: '0.001', ts: now, expiresAt: now + 10_000, source: 'test' };
}

describe('decimal accounting', () => {
  it('avoids floating point error', () => {
    expect(s(d('0.1').plus('0.2'))).toBe('0.3');
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(s(d('1000').times('0.0075').div(3), 8)).toBe('2.5');
  });
  it('computes percentage change', () => {
    expect(pctChange('100', '125').toFixed(2)).toBe('25.00');
    expect(pctChange('0', '5').toNumber()).toBe(0);
  });
});

describe('state machine', () => {
  const cand = (): Candidate => ({ id: 'c', chain: 'simnet', pool: {} as Candidate['pool'], stage: 'DISCOVERED', stageReason: null, stageHistory: [], discoveredAt: 0, updatedAt: 0, expiresAt: 0, scannerScore: 0, snapshot: null, riskVerdict: null, riskScore: null, riskAssessmentId: null, signalScore: null, strategy: null, proposalId: null, positionId: null, lastEvaluatedAt: null, evaluations: 0, nextEvalAt: 0 });
  it('allows the defined path', () => {
    const c = cand();
    for (const st of ['SCREENING', 'ELIGIBLE', 'SIGNAL_EVALUATION', 'TRADE_PROPOSED', 'RISK_APPROVED', 'EXECUTION_PENDING', 'OPEN', 'EXIT_PENDING', 'CLOSED'] as const) transition(c, st, null, 1);
    expect(c.stage).toBe('CLOSED');
    expect(c.stageHistory).toHaveLength(9);
  });
  it('prevents skipping stages', () => {
    const c = cand();
    expect(() => transition(c, 'OPEN', null, 1)).toThrow(InvalidTransitionError);
    transition(c, 'SCREENING', null, 1);
    transition(c, 'ELIGIBLE', null, 1);
    expect(() => transition(c, 'EXECUTION_PENDING', null, 1)).toThrow(InvalidTransitionError);
    expect(canTransition('CLOSED', 'OPEN')).toBe(false);
    expect(canTransition('REJECTED', 'ELIGIBLE')).toBe(false);
  });
});

describe('risk guard', () => {
  const run = (r: SecurityReport | null, sn = snap(), extra: Partial<Parameters<typeof evaluateRisk>[0]> = {}) => evaluateRisk({ report: r, snapshot: sn, trading: cfg.trading, risk: cfg.risk, now: T0, ...extra });
  it('passes a clean token without calling it safe', () => {
    const r = run(report());
    expect(r.verdict).toBe('PASS');
    expect(r.summary).toMatch(/^PASS/);
    expect(r.summary).not.toMatch(/safe/i);
  });
  it('rejects honeypots / failed sell simulation', () => {
    const r = run(report({ sellSimulationOk: false }));
    expect(r.verdict).toBe('REJECT');
    expect(r.factors.map((f) => f.code)).toContain('SELL_RESTRICTED');
  });
  it('never treats unknown critical data as safe', () => {
    expect(run(report({ sellSimulationOk: null })).verdict).toBe('REJECT');
    const r = run(report({ mintAuthorityRenounced: null }));
    expect(r.verdict).toBe('REVIEW');
    expect(run(null, snap(), { reportError: 'timeout' }).verdict).toBe('REJECT');
  });
  it('does not accept an unverified LP-lock claim', () => {
    const r = run(report({ lpLock: { claimed: true, verified: false, lockedPct: '100', unlockAt: null, evidence: null } }));
    expect(r.factors.find((f) => f.code === 'LP_LOCK_UNVERIFIED')).toBeTruthy();
    const strict = evaluateRisk({ report: report({ lpLock: { claimed: true, verified: null, lockedPct: '90', unlockAt: null, evidence: null } }), snapshot: snap(), trading: cfg.trading, risk: { ...cfg.risk, thresholds: { ...cfg.risk.thresholds, requireVerifiedLpLock: true } }, now: T0 });
    expect(strict.verdict).toBe('REJECT');
  });
  it('rejects stale market data', () => {
    const r = run(report(), snap({ ts: T0 - 120_000 }));
    expect(r.verdict).toBe('REJECT');
    expect(r.factors[0]!.code).toBe('STALE_MARKET_DATA');
  });
  it('flags holder concentration, freeze authority, taxes and wash trading', () => {
    expect(run(report({ top10HolderPct: '80' })).verdict).toBe('REJECT');
    expect(run(report({ freezeAuthorityRenounced: false })).verdict).toBe('REJECT');
    expect(run(report({ transferTaxPct: '5' })).verdict).toBe('REJECT');
    const wash = run(report(), snap({ txns: { m5: { buys: 50, sells: 48 }, h1: { buys: 100, sells: 100 } }, uniqueTraders5m: 5 }));
    expect(wash.factors.map((f) => f.code)).toContain('WASH_TRADING');
    expect(wash.verdict).toBe('REJECT');
  });
  it('enforces price impact for the intended size', () => {
    const big = quote('buy', '2000');
    const r = run(report(), snap(), { quote: big });
    expect(r.factors.map((f) => f.code)).toContain('PRICE_IMPACT');
    expect(r.verdict).toBe('REJECT');
  });
  it('merges providers conservatively', () => {
    const m = mergeSecurityReports([report({ sellSimulationOk: true }), report({ sellSimulationOk: false, top10HolderPct: '33' })], T0);
    expect(m.sellSimulationOk).toBe(false);
    expect(m.top10HolderPct).toBe('33');
    expect(m.providerFlags).toContain('conflict:sellSimulationOk');
  });
});

describe('sizer', () => {
  const base = (): SizingInput => ({
    portfolio: { equity: '1000', dayStartEquity: '1000', peakEquity: '1000', cash: '1000', reserved: '0', openExposure: '0', tokenExposure: '0', newLaunchExposure: '0', openPositions: 0, consecutiveLosses: 0, lossCooldownUntil: null },
    trading: cfg.trading,
    risk: cfg.risk,
    hard: DEFAULT_HARD_LIMITS,
    liquidity: '40000',
    stopLossPct: '12',
    estEntryCostPct: '0.5',
    estExitCostPct: '0.5',
    riskVerdict: 'PASS',
    isNewLaunch: true,
    now: T0,
  });
  it('treats equity allocation as an upper bound and reports the binding limit', () => {
    const r = sizePosition(base());
    expect(r.approved).toBe(true);
    // 4% of 1000 = 40; risk budget = 7.5 / 0.13 = 57.69; liquidity 1.5% of 40000 = 600
    expect(r.size).toBe('40');
    expect(r.constraints.find((c) => c.binding)?.name).toBe('equityAllocation');
  });
  it('caps by executable liquidity', () => {
    const r = sizePosition({ ...base(), liquidity: '1000' });
    expect(r.size).toBe('15');
    expect(r.constraints.find((c) => c.binding)?.name).toBe('liquidityParticipation');
  });
  it('blocks on daily loss, drawdown, concurrency and loss cooldown', () => {
    const b = base();
    expect(sizePosition({ ...b, portfolio: { ...b.portfolio, equity: '910' } }).approved).toBe(false);
    expect(sizePosition({ ...b, portfolio: { ...b.portfolio, equity: '910' } }).deferred).toBe(true);
    expect(sizePosition({ ...b, portfolio: { ...b.portfolio, peakEquity: '1300', dayStartEquity: '1000' } }).reasons.join()).toMatch(/drawdown/);
    expect(sizePosition({ ...b, portfolio: { ...b.portfolio, openPositions: 4 } }).reasons.join()).toMatch(/concurrent/);
    expect(sizePosition({ ...b, portfolio: { ...b.portfolio, consecutiveLosses: 5, lossCooldownUntil: T0 + 1000 } }).approved).toBe(false);
  });
  it('shrinks REVIEW verdicts under the strict policy and refuses below minimum', () => {
    const r = sizePosition({ ...base(), riskVerdict: 'REVIEW' });
    expect(r.size).toBe('20');
    const tiny = sizePosition({ ...base(), portfolio: { ...base().portfolio, cash: '9' } });
    expect(tiny.approved).toBe(false);
    expect(tiny.reasons.join()).toMatch(/below minimum/);
  });
  it('never exceeds hard limits even if config is looser', () => {
    const r = sizePosition({ ...base(), portfolio: { ...base().portfolio, equity: '100000', cash: '100000', dayStartEquity: '100000', peakEquity: '100000' }, risk: { ...cfg.risk, maxPositionSizeQuote: '100000' }, liquidity: '10000000' });
    expect(d(r.size).lte(DEFAULT_HARD_LIMITS.maxPositionSizeQuote)).toBe(true);
  });
});

describe('exit manager', () => {
  const pos = (over: Partial<Position> = {}): Position => ({
    id: 'p', mode: 'paper', chain: 'simnet', candidateId: 'c', proposalId: 'pr', tokenAddress: 'T', poolAddress: 'P', symbol: 'X', strategy: 'new_pool_entry', strategyVersion: '1', status: 'open',
    entryQty: '40000', qty: '40000', costBasis: '40', openCostBasis: '40', entryFillPrice: '0.001', entryFeesQuote: '0.1', entryLiquidity: '40000', exitFeesQuote: '0', proceeds: '0', realizedPnl: '0',
    exitPolicy: structuredClone(DEFAULT_EXIT_POLICY), highWaterValuePerToken: '0', stopPricePerToken: s(d('0.001').times(0.88), 18), trailingActive: false, breakEvenArmed: false, tpLevelsHit: 0, exitFailures: 0, unsellable: false,
    openedAt: T0, closedAt: null, lastMark: null, riskScore: 10, entryRationale: '', exitReason: null, exitRationale: null, orderIds: [], ...over,
  });
  // rq/rt set so that the sell quote for 40000 tokens is near the target value
  const at = (price: number, qty = '40000') => quote('sell', qty, 20_000 / price, 20_000);
  it('holds and marks against the executable quote, not mid', () => {
    const e = evaluateExit({ position: pos(), quote: at(0.001), quoteError: null, snapshot: snap(), now: T0 + 1000 });
    expect(e.action).toBe('hold');
    expect(d(e.mark.liquidationValue!).lt(e.mark.markValue!)).toBe(true);
    expect(d(e.mark.unrealizedPnl!).lt(0)).toBe(true);
  });
  it('triggers a stop loss', () => {
    const e = evaluateExit({ position: pos(), quote: at(0.00085), quoteError: null, snapshot: snap(), now: T0 + 1000 });
    expect(e.action).toBe('exit');
    expect(e.reason).toBe('stop_loss');
  });
  it('takes partial profit at the first target', () => {
    const e = evaluateExit({ position: pos(), quote: at(0.00128), quoteError: null, snapshot: snap(), now: T0 + 1000 });
    expect(e.reason).toBe('take_profit');
    expect(e.fraction).toBe('0.5');
    expect(e.updates.trailingActive).toBe(true);
    expect(e.updates.breakEvenArmed).toBe(true);
  });
  it('activates and then hits a trailing stop', () => {
    const e1 = evaluateExit({ position: pos({ tpLevelsHit: 1 }), quote: at(0.00122), quoteError: null, snapshot: snap(), now: T0 + 1000 });
    expect(e1.action).toBe('hold');
    const p2 = pos({ tpLevelsHit: 1, ...e1.updates } as Partial<Position>);
    const e2 = evaluateExit({ position: p2, quote: at(0.00107), quoteError: null, snapshot: snap(), now: T0 + 2000 });
    expect(e2.action).toBe('exit');
    expect(e2.reason).toBe('trailing_stop');
  });
  it('time stop, liquidity deterioration and missing quote', () => {
    expect(evaluateExit({ position: pos(), quote: at(0.001), quoteError: null, snapshot: snap(), now: T0 + 21 * 60_000 }).reason).toBe('time_stop');
    expect(evaluateExit({ position: pos(), quote: at(0.001), quoteError: null, snapshot: snap({ liquidity: '20000' }), now: T0 + 1000 }).reason).toBe('liquidity_deterioration');
    const none = evaluateExit({ position: pos(), quote: null, quoteError: 'down', snapshot: snap(), now: T0 + 1000 });
    expect(none.action).toBe('hold');
    expect(none.mark.quoteError).toBe('down');
  });
});

describe('accountant', () => {
  it('accounts entry, exit and fees exactly', () => {
    let l = newLedger('paper', '1000', T0);
    l = reserve(l, '40.003', T0);
    expect(() => reserve(l, '2000', T0)).toThrow();
    l = { ...l, reserved: '0' };
    l = applyEntryFill(l, '40', '0.003', T0);
    expect(l.cash).toBe('959.997');
    l = applyExitFill(l, '50', '0.003', '40.003', T0);
    expect(l.cash).toBe('1009.994');
    expect(l.realizedPnl).toBe('9.994');
    expect(l.feesPaid).toBe('0.006');
    l = applyFailedTx(l, '0.003', T0);
    expect(l.realizedPnl).toBe('9.991');
  });
  it('does not count deposits or withdrawals as P&L', () => {
    let l = newLedger('paper', '1000', T0);
    l = applyDeposit(l, '500', T0);
    l = applyWithdrawal(l, '200', T0);
    const perf = computePerformance(l, [], [], [], { submitted: 0, failed: 0 });
    expect(perf.netPnl).toBe('0');
    expect(perf.realizedPnl).toBe('0');
    expect(perf.equity).toBe('1300');
    expect(() => applyWithdrawal(l, '99999', T0)).toThrow();
  });
  it('values unquotable / unsellable positions at zero', () => {
    const l = newLedger('paper', '1000', T0);
    const mk = (id: string, lv: string | null, unsellable = false) => ({ id, mode: 'paper', status: 'open', openCostBasis: '10', unsellable, lastMark: lv === null ? null : { liquidationValue: lv, markValue: lv } }) as unknown as Position;
    const v = valuePortfolio(l, [mk('a', '12'), mk('b', null), mk('c', '9', true)]);
    expect(v.openLiquidation.toFixed()).toBe('12');
    expect(v.unvalued).toBe(2);
  });
  it('computes win rate, profit factor and per-strategy stats', () => {
    const t = (net: string, strategy = 'new_pool_entry') => ({ mode: 'paper', netPnl: net, strategy, holdSec: 60, slippagePct: '0.1' }) as unknown as Trade;
    const perf = computePerformance(newLedger('paper', '1000', T0), [], [t('10'), t('-4'), t('6', 'volume_spike')], [], { submitted: 6, failed: 1 });
    expect(perf.wins).toBe(2);
    expect(perf.losses).toBe(1);
    expect(perf.profitFactor).toBe(4);
    expect(perf.byStrategy.new_pool_entry?.trades).toBe(2);
    expect(perf.failedTxRate).toBeCloseTo(1 / 6);
  });
});

describe('executor pre-trade checks', () => {
  const base = (): EntryCheckInput => {
    const q = quote('buy', '40');
    const proposal = { id: 'pr', candidateId: 'c', mode: 'paper', chain: 'simnet', tokenAddress: 'T', poolAddress: 'P', symbol: 'X', size: '40', maxEntryPrice: '0.00106', status: 'approved', expiresAt: T0 + 10_000, riskVerdict: 'PASS' } as unknown as TradeProposal;
    return {
      proposal,
      candidate: { chain: 'simnet', pool: { address: 'P', token: { address: 'T' } } } as unknown as Candidate,
      mode: 'paper', liveAuthorized: false, hasAdapter: true, killSwitch: false, entriesBlockedReason: null,
      snapshot: snap(),
      assessment: { phase: 'pre_execution', ts: T0, verdict: 'PASS' } as never,
      quote: q, quoteError: null,
      sizingNow: { approved: true, maxAllowed: '40', reasons: [] } as never,
      ledger: newLedger('paper', '1000', T0),
      trading: cfg.trading, risk: cfg.risk, hard: DEFAULT_HARD_LIMITS,
      conflictingExposure: 0, idempotencyKeyUsed: false, manualApprovalRequired: false, approvedBy: null, now: T0,
    };
  };
  it('passes all checks and computes minOut from the slippage cap', () => {
    const r = entryPreTradeChecks(base());
    expect(r.ok).toBe(true);
    expect(d(r.minOut!).lt(base().quote!.expectedOut)).toBe(true);
    expect(r.checks.length).toBeGreaterThanOrEqual(13);
  });
  it('blocks when the price exceeds the max entry price (slippage)', () => {
    const b = base();
    b.proposal = { ...b.proposal, maxEntryPrice: '0.0009' };
    const r = entryPreTradeChecks(b);
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === 'max_entry_price')?.ok).toBe(false);
  });
  it('blocks duplicates, expired proposals, stale data and kill switch', () => {
    expect(entryPreTradeChecks({ ...base(), idempotencyKeyUsed: true }).retryable).toBe(false);
    expect(entryPreTradeChecks({ ...base(), conflictingExposure: 1 }).ok).toBe(false);
    expect(entryPreTradeChecks({ ...base(), now: T0 + 20_000 }).ok).toBe(false);
    expect(entryPreTradeChecks({ ...base(), snapshot: snap({ ts: T0 - 60_000 }) }).ok).toBe(false);
    expect(entryPreTradeChecks({ ...base(), killSwitch: true }).ok).toBe(false);
    expect(entryPreTradeChecks({ ...base(), quote: null, quoteError: 'x' }).ok).toBe(false);
  });
  it('refuses live orders without authorization and manual approval', () => {
    const b = base();
    b.proposal = { ...b.proposal, mode: 'live' };
    expect(entryPreTradeChecks({ ...b, mode: 'live', liveAuthorized: false }).ok).toBe(false);
    expect(entryPreTradeChecks({ ...b, mode: 'live', liveAuthorized: true, manualApprovalRequired: true, approvedBy: null }).ok).toBe(false);
    expect(entryPreTradeChecks({ ...b, mode: 'live', liveAuthorized: true, manualApprovalRequired: true, approvedBy: 'admin' }).ok).toBe(true);
  });
});

describe('strategies', () => {
  const ctx = (over: Partial<MarketSnapshot> = {}, createdAgo = 120_000) => ({
    pool: { createdAt: T0 - createdAgo } as never,
    snapshot: snap(over),
    history: [snap({ ts: T0 - 20_000, liquidity: '30000' }), snap({ ts: T0 - 10_000, price: '0.0009' })],
    now: T0,
    params: cfg.trading.strategyParams,
    risk: { verdict: 'PASS' as const, score: 5, confidence: 1 },
  });
  it('new pool entry signals within its window and explains skips', () => {
    const r = STRATEGIES.new_pool_entry.evaluate(ctx());
    expect(r.kind).toBe('signal');
    if (r.kind === 'signal') expect(r.rationale).toMatch(/buy\/sell/);
    const young = STRATEGIES.new_pool_entry.evaluate(ctx({}, 10_000));
    expect(young.kind).toBe('skip');
    const chase = STRATEGIES.new_pool_entry.evaluate(ctx({ priceChange: { m1: '1', m5: '200', h1: null } }));
    expect(chase.kind === 'skip' && chase.reason).toMatch(/chase/);
  });
  it('liquidity momentum requires liquidity growth', () => {
    expect(STRATEGIES.liquidity_momentum.evaluate(ctx()).kind).toBe('skip');
    const r = STRATEGIES.liquidity_momentum.evaluate({ ...ctx(), history: [snap({ liquidity: '30000' }), snap({ liquidity: '32000' }), snap({ liquidity: '35000' })] });
    expect(r.kind).toBe('signal');
  });
});

describe('config validation', () => {
  it('accepts defaults and rejects hard-limit bypass', () => {
    expect(EngineConfigSchema.safeParse(DEFAULT_CONFIG).success).toBe(true);
    expect(checkHardLimits(DEFAULT_CONFIG, DEFAULT_HARD_LIMITS)).toEqual([]);
    const loose = structuredClone(DEFAULT_CONFIG);
    loose.risk.maxPositionSizeQuote = '99999';
    loose.trading.maxSlippagePct = '30';
    const v = checkHardLimits(loose, DEFAULT_HARD_LIMITS);
    expect(v.map((x) => x.path)).toEqual(expect.arrayContaining(['risk.maxPositionSizeQuote', 'trading.maxSlippagePct']));
  });
  it('rejects malicious / malformed inputs', () => {
    const bad = structuredClone(DEFAULT_CONFIG) as unknown as { trading: Record<string, unknown> };
    bad.trading.maxTradeAllocationPct = '1e9';
    expect(EngineConfigSchema.safeParse(bad).success).toBe(false);
    bad.trading.maxTradeAllocationPct = '-1';
    expect(EngineConfigSchema.safeParse(bad).success).toBe(false);
    bad.trading.maxTradeAllocationPct = '<script>';
    expect(EngineConfigSchema.safeParse(bad).success).toBe(false);
  });
});

describe('secret redaction', () => {
  it('redacts key-like material from log text', () => {
    const fakeKey = '4'.repeat(88);
    expect(redact(`key ${fakeKey} leaked`)).toBe('key [redacted] leaked');
    expect(redact(`[${Array.from({ length: 64 }, () => '12').join(',')}]`)).toBe('[redacted]');
    expect(redact('a normal sentence with many words that should definitely remain entirely intact here ok')).toMatch(/normal/);
  });
});
