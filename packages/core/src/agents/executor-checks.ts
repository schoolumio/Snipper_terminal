import type { HardLimits, RiskConfig, TradingConfig } from '../config';
import { d, min, pct, s } from '../decimal';
import type { Candidate, Ledger, MarketSnapshot, Quote, RiskAssessment, TradeProposal, TradingMode } from '../types';
import type { SizingResult } from './sizer';

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface EntryCheckInput {
  proposal: TradeProposal;
  candidate: Candidate;
  mode: TradingMode;
  liveAuthorized: boolean;
  hasAdapter: boolean;
  killSwitch: boolean;
  entriesBlockedReason: string | null;
  snapshot: MarketSnapshot | null;
  assessment: RiskAssessment | null;
  quote: Quote | null;
  quoteError: string | null;
  sizingNow: SizingResult;
  ledger: Ledger;
  trading: TradingConfig;
  risk: RiskConfig;
  hard: HardLimits;
  /** Open positions or unsettled orders already on this token. */
  conflictingExposure: number;
  idempotencyKeyUsed: boolean;
  manualApprovalRequired: boolean;
  approvedBy: string | null;
  now: number;
}

export interface EntryCheckOutcome {
  ok: boolean;
  checks: CheckResult[];
  minOut: string | null;
  /** True when the failure is transient (worth re-evaluating later). */
  retryable: boolean;
}

/** Maximum age of the pre-execution risk assessment the executor will accept. */
export const MAX_ASSESSMENT_AGE_MS = 30_000;

/**
 * The executor's pre-trade gate. Every check runs (so the audit log shows the
 * full picture) and any single failure blocks the order.
 */
export function entryPreTradeChecks(i: EntryCheckInput): EntryCheckOutcome {
  const checks: CheckResult[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const p = i.proposal;
  const maxSlip = min(i.trading.maxSlippagePct, i.hard.maxSlippagePct);
  const maxImpact = min(i.trading.maxPriceImpactPct, i.hard.maxPriceImpactPct);

  add('kill_switch', !i.killSwitch, i.killSwitch ? 'kill switch active' : 'clear');
  add('entries_enabled', i.entriesBlockedReason === null, i.entriesBlockedReason ?? 'entries enabled');
  // 1. trading mode
  const modeOk = p.mode === i.mode && (i.mode === 'paper' || (i.liveAuthorized && i.hasAdapter));
  add('trading_mode', modeOk, modeOk ? `${i.mode}` : `proposal mode ${p.mode}, engine ${i.mode}, live authorized=${i.liveAuthorized}, adapter=${i.hasAdapter}`);
  // 2. proposal validity
  const valid = d(p.size).gt(0) && d(p.maxEntryPrice).gt(0) && p.status === 'approved';
  add('proposal_valid', valid, valid ? 'valid' : `status=${p.status} size=${p.size}`);
  // 3. identifiers
  const idsOk = p.tokenAddress === i.candidate.pool.token.address && p.poolAddress === i.candidate.pool.address && p.chain === i.candidate.chain && (!i.snapshot || (i.snapshot.poolAddress === p.poolAddress && i.snapshot.tokenAddress === p.tokenAddress));
  add('identifiers', idsOk, idsOk ? 'token/pool match' : 'token or pool identifier mismatch');
  // 4. expiry
  const fresh = i.now <= p.expiresAt;
  add('not_expired', fresh, fresh ? `${Math.round((p.expiresAt - i.now) / 1000)}s left` : 'proposal expired');
  // 5. market data freshness
  const ageSec = i.snapshot ? (i.now - i.snapshot.ts) / 1000 : Infinity;
  const dataOk = ageSec <= i.risk.thresholds.maxDataAgeSec;
  add('data_fresh', dataOk, i.snapshot ? `market data ${ageSec.toFixed(1)}s old` : 'no market data');
  // 6. risk screening recheck
  const a = i.assessment;
  const riskOk = !!a && a.phase === 'pre_execution' && i.now - a.ts <= MAX_ASSESSMENT_AGE_MS && a.verdict !== 'REJECT';
  add('risk_recheck', riskOk, a ? `${a.verdict} (${Math.round((i.now - a.ts) / 1000)}s ago)` : 'no pre-execution assessment');
  // 7 + 11. balances, portfolio and exposure limits recomputed now
  const available = d(i.ledger.cash).minus(i.ledger.reserved);
  const balOk = available.gte(d(p.size).plus(i.risk.minFeeReserveQuote));
  add('balance', balOk, `available ${available.toFixed(2)} vs size ${p.size} + reserve ${i.risk.minFeeReserveQuote}`);
  const limitsOk = i.sizingNow.approved && d(p.size).lte(i.sizingNow.maxAllowed);
  add('portfolio_limits', limitsOk, limitsOk ? `size ${p.size} ≤ max ${i.sizingNow.maxAllowed}` : i.sizingNow.reasons.join('; ') || `size ${p.size} > max ${i.sizingNow.maxAllowed}`);
  // 8. fresh quote
  const q = i.quote;
  const quoteOk = !!q && i.now <= q.expiresAt && q.side === 'buy' && d(q.amountIn).eq(p.size);
  add('fresh_quote', quoteOk, q ? `quote ${q.id} out=${q.expectedOut}` : `no quote: ${i.quoteError ?? 'unavailable'}`);
  let minOut: string | null = null;
  if (q) {
    // 9 + 10. slippage, price impact, total cost
    const impact = d(q.priceImpactPct);
    add('price_impact', impact.lte(maxImpact), `impact ${impact.toFixed(3)}% (max ${maxImpact.toFixed(2)}%)`);
    const priceOk = d(q.effectivePrice).lte(p.maxEntryPrice);
    add('max_entry_price', priceOk, `effective ${d(q.effectivePrice).toSignificantDigits(6).toString()} vs max ${d(p.maxEntryPrice).toSignificantDigits(6).toString()}`);
    const feeOk = d(q.networkFeeQuote).plus(i.trading.priorityFeeQuote).lte(i.trading.maxNetworkFeeQuote);
    add('network_fee', feeOk, `fee ${q.networkFeeQuote}+${i.trading.priorityFeeQuote} (max ${i.trading.maxNetworkFeeQuote})`);
    minOut = s(d(q.expectedOut).times(d(1).minus(pct(maxSlip))), 12);
    add('slippage_cap', true, `minOut ${minOut} at ${maxSlip.toFixed(2)}% slippage`);
  }
  // 12. duplicates / conflicts
  add('no_duplicate', !i.idempotencyKeyUsed && i.conflictingExposure === 0, i.idempotencyKeyUsed ? 'order already submitted for this proposal' : i.conflictingExposure > 0 ? 'existing position/order on this token' : 'none');
  // 13. live authorization
  const authOk = i.mode === 'paper' || (i.liveAuthorized && (!i.manualApprovalRequired || !!i.approvedBy));
  add('authorization', authOk, i.mode === 'paper' ? 'paper mode' : authOk ? `live authorized${i.approvedBy ? `, approved by ${i.approvedBy}` : ''}` : 'live trade requires authorization / manual approval');

  const failed = checks.filter((c) => !c.ok);
  const nonRetryable = new Set(['identifiers', 'no_duplicate', 'proposal_valid', 'risk_recheck']);
  return { ok: failed.length === 0, checks, minOut, retryable: failed.every((c) => !nonRetryable.has(c.name)) };
}
