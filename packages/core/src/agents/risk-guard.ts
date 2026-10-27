import type { RiskConfig, TradingConfig } from '../config';
import { d, num } from '../decimal';
import type { MarketSnapshot, Quote, RiskFactor, RiskVerdict, SecurityReport, Severity } from '../types';

export interface RiskInput {
  report: SecurityReport | null;
  /** Error from the security provider, if the report could not be fetched. */
  reportError?: string | null;
  snapshot: MarketSnapshot;
  /** Buy quote for the intended size, when available (pre-execution phase). */
  quote?: Quote | null;
  /** Sell quote for the expected token amount, to check exit liquidity. */
  exitQuote?: Quote | null;
  trading: TradingConfig;
  risk: RiskConfig;
  now: number;
}

export interface RiskResult {
  verdict: RiskVerdict;
  riskScore: number;
  confidence: number;
  factors: RiskFactor[];
  summary: string;
}

const WEIGHT: Record<Severity, number> = { critical: 100, high: 25, medium: 10, low: 3, info: 0 };

/**
 * Deterministic token risk screening. PASS only means the configured checks
 * found nothing disqualifying; it is never a statement that a token is safe.
 * Missing critical data is treated as risk, never as safety.
 */
export function evaluateRisk(input: RiskInput): RiskResult {
  const { report, snapshot: snap, trading, risk, now } = input;
  const th = risk.thresholds;
  const factors: RiskFactor[] = [];
  const src = report?.source ?? 'none';
  const at = report?.fetchedAt ?? now;
  const add = (code: string, severity: Severity, message: string, value: string | null, blocking: boolean, source = src, observedAt = at) =>
    factors.push({ code, severity, message, value, source, observedAt, blocking });

  // ── data freshness ──
  const ageSec = (now - snap.ts) / 1000;
  if (ageSec > th.maxDataAgeSec) add('STALE_MARKET_DATA', 'critical', `market data is ${ageSec.toFixed(0)}s old (max ${th.maxDataAgeSec}s)`, ageSec.toFixed(0), true, snap.source, snap.ts);
  if (report && (now - report.fetchedAt) / 1000 > Math.max(th.maxDataAgeSec * 10, 120))
    add('STALE_SECURITY_DATA', 'high', 'security assessment is stale', null, true);

  // ── security report ──
  let known = 0;
  let expected = 0;
  const unknownCritical: string[] = [];
  if (!report) {
    add('SECURITY_DATA_UNAVAILABLE', 'critical', `no security data: ${input.reportError ?? 'provider returned nothing'}`, null, true);
  } else {
    const k = (v: unknown, name: string, critical: boolean) => {
      expected++;
      if (v === null || v === undefined) {
        if (critical) unknownCritical.push(name);
        return false;
      }
      known++;
      return true;
    };
    if (k(report.knownMalicious, 'knownMalicious', true) && report.knownMalicious) add('KNOWN_MALICIOUS', 'critical', 'token or deployer flagged as malicious by provider', 'true', true);
    if (k(report.sellSimulationOk, 'sellSimulation', th.requireSellSimulation)) {
      if (!report.sellSimulationOk) add('SELL_RESTRICTED', 'critical', 'sell simulation failed — possible honeypot / sell restriction', 'false', true);
    } else if (th.requireSellSimulation) add('SELL_SIM_UNKNOWN', 'high', 'sell simulation unavailable; sellability unverified', null, true);
    if (k(report.freezeAuthorityRenounced, 'freezeAuthority', th.requireFreezeRenounced)) {
      if (!report.freezeAuthorityRenounced) add('FREEZE_AUTHORITY', th.requireFreezeRenounced ? 'critical' : 'high', 'freeze authority active — holder accounts can be frozen', 'active', th.requireFreezeRenounced);
    }
    if (k(report.mintAuthorityRenounced, 'mintAuthority', th.requireMintRenounced)) {
      if (!report.mintAuthorityRenounced) add('MINT_AUTHORITY', 'high', 'mint authority active — supply can be inflated', 'active', th.requireMintRenounced);
    }
    if (k(report.top10HolderPct, 'top10HolderPct', false)) {
      const v = d(report.top10HolderPct);
      if (v.gt(th.maxTop10HolderPct)) add('HOLDER_CONCENTRATION', 'high', `top-10 holders own ${v.toFixed(1)}% (max ${th.maxTop10HolderPct}%)`, v.toFixed(2), true);
      else if (v.gt(d(th.maxTop10HolderPct).times(0.8))) add('HOLDER_CONCENTRATION_ELEVATED', 'medium', `top-10 holders own ${v.toFixed(1)}%`, v.toFixed(2), false);
    } else add('HOLDERS_UNKNOWN', 'medium', 'holder distribution unavailable', null, false);
    if (k(report.creatorHoldingPct, 'creatorHoldingPct', false)) {
      const v = d(report.creatorHoldingPct);
      if (v.gt(th.maxCreatorHoldingPct)) add('CREATOR_HOLDING', 'high', `creator holds ${v.toFixed(1)}% (max ${th.maxCreatorHoldingPct}%)`, v.toFixed(2), true);
    }
    if (k(report.transferTaxPct, 'transferTax', false)) {
      const v = d(report.transferTaxPct);
      if (v.gt(th.maxTransferTaxPct)) add('TRANSFER_TAX', 'high', `transfer tax ${v.toFixed(2)}% (max ${th.maxTransferTaxPct}%)`, v.toFixed(2), true);
    }
    if (k(report.creatorPriorFlaggedTokens, 'creatorHistory', false) && (report.creatorPriorFlaggedTokens ?? 0) > 0)
      add('CREATOR_HISTORY', 'high', `deployer linked to ${report.creatorPriorFlaggedTokens} previously flagged token(s)`, String(report.creatorPriorFlaggedTokens), true);
    if (report.holderCount !== null && report.holderCount < th.minHolders) add('FEW_HOLDERS', 'medium', `only ${report.holderCount} holders (min ${th.minHolders})`, String(report.holderCount), false);
    // LP lock: a claim is not evidence.
    const lp = report.lpLock;
    if (!lp || !lp.claimed) {
      add('LP_UNLOCKED', th.requireVerifiedLpLock ? 'high' : 'medium', 'no liquidity lock — liquidity can be withdrawn', null, th.requireVerifiedLpLock);
    } else if (lp.verified !== true) {
      add('LP_LOCK_UNVERIFIED', th.requireVerifiedLpLock ? 'high' : 'medium', 'liquidity lock claimed but not independently verified — treated as unlocked', lp.lockedPct, th.requireVerifiedLpLock);
    }
    for (const flag of report.providerFlags) {
      if (flag.startsWith('conflict:')) add('CONTRADICTORY_DATA', 'high', `providers disagree on ${flag.slice(9)}`, null, false);
      else add('PROVIDER_FLAG', 'medium', `provider flag: ${flag}`, flag, false);
    }
    for (const u of unknownCritical) add(`UNKNOWN_${u.toUpperCase()}`, 'medium', `${u} could not be determined`, null, false);
  }

  // ── market structure ──
  const liq = d(snap.liquidity);
  if (liq.lt(trading.minLiquidity)) add('LOW_LIQUIDITY', 'high', `liquidity ${liq.toFixed(0)} below minimum ${trading.minLiquidity}`, liq.toFixed(2), true, snap.source, snap.ts);
  if (liq.gt(trading.maxLiquidity)) add('LIQUIDITY_ABOVE_MAX', 'info', `liquidity above configured max ${trading.maxLiquidity}`, liq.toFixed(2), true, snap.source, snap.ts);
  if (snap.marketCap !== null && d(snap.marketCap).gt(0)) {
    const ratio = liq.div(snap.marketCap).times(100);
    if (ratio.lt(th.minLiquidityToMcapPct)) add('THIN_LIQUIDITY_VS_MCAP', 'high', `liquidity is ${ratio.toFixed(1)}% of market cap (min ${th.minLiquidityToMcapPct}%)`, ratio.toFixed(2), true, snap.source, snap.ts);
  }
  const vol1h = d(snap.volume.h1);
  if (liq.gt(0) && vol1h.div(liq).gt(th.maxVolumeToLiquidity1h)) add('VOLUME_ANOMALY', 'high', `1h volume is ${vol1h.div(liq).toFixed(1)}× liquidity`, vol1h.div(liq).toFixed(2), true, snap.source, snap.ts);
  // Wash-trading heuristic: many trades from very few wallets with balanced flow.
  const tx5 = snap.txns.m5.buys + snap.txns.m5.sells;
  if (snap.uniqueTraders5m !== null && tx5 >= 30) {
    const uniq = snap.uniqueTraders5m / tx5;
    const balance = Math.abs(snap.txns.m5.buys - snap.txns.m5.sells) / tx5;
    if (uniq < 0.2 && balance < 0.15) add('WASH_TRADING', 'high', `${tx5} trades from ~${snap.uniqueTraders5m} wallets with balanced flow — likely wash trading`, uniq.toFixed(2), true, snap.source, snap.ts);
  }

  // ── execution feasibility ──
  if (input.quote) {
    const impact = d(input.quote.priceImpactPct);
    if (impact.gt(trading.maxPriceImpactPct)) add('PRICE_IMPACT', 'high', `entry price impact ${impact.toFixed(2)}% exceeds ${trading.maxPriceImpactPct}%`, impact.toFixed(3), true, input.quote.source, input.quote.ts);
    if (d(input.quote.networkFeeQuote).gt(trading.maxNetworkFeeQuote)) add('NETWORK_FEE', 'high', `network fee ${input.quote.networkFeeQuote} exceeds cap ${trading.maxNetworkFeeQuote}`, input.quote.networkFeeQuote, true, input.quote.source, input.quote.ts);
  }
  if (input.exitQuote) {
    const impact = d(input.exitQuote.priceImpactPct);
    if (impact.gt(d(trading.maxPriceImpactPct).times(2))) add('EXIT_LIQUIDITY', 'high', `exiting this size now would cost ${impact.toFixed(2)}% price impact`, impact.toFixed(3), true, input.exitQuote.source, input.exitQuote.ts);
  }

  const raw = factors.reduce((a, f) => a + WEIGHT[f.severity], 0);
  const riskScore = Math.min(100, raw);
  const confidence = report ? (expected === 0 ? 0 : known / expected) : 0;
  const blocking = factors.filter((f) => f.blocking);
  const criticalUnknown = unknownCritical.length > 0;

  let verdict: RiskVerdict;
  if (blocking.length > 0 || factors.some((f) => f.severity === 'critical') || riskScore > risk.maxRiskScore) verdict = 'REJECT';
  else if (criticalUnknown || confidence < risk.minRiskConfidence || riskScore > risk.reviewRiskScore) verdict = 'REVIEW';
  else verdict = 'PASS';

  const summary =
    verdict === 'REJECT'
      ? `REJECT — ${(blocking[0] ?? factors.find((f) => f.severity === 'critical') ?? { message: `risk score ${riskScore} > ${risk.maxRiskScore}` }).message}`
      : verdict === 'REVIEW'
        ? `REVIEW — ${criticalUnknown ? `unknown: ${unknownCritical.join(', ')}` : confidence < risk.minRiskConfidence ? `low data confidence ${(confidence * 100).toFixed(0)}%` : `risk score ${riskScore} above review threshold`}`
        : `PASS — risk ${riskScore} within threshold (${factors.length} non-blocking factor${factors.length === 1 ? '' : 's'})`;

  return { verdict, riskScore, confidence: Math.round(confidence * 100) / 100, factors, summary };
}

/** Scanner pre-filter score: 0..100 market-quality score; no security inputs. */
export function scannerScore(snap: MarketSnapshot, trading: TradingConfig, now: number, poolCreatedAt: number): { score: number; notes: string[] } {
  const notes: string[] = [];
  let score = 0;
  const liq = num(snap.liquidity);
  const minLiq = num(trading.minLiquidity);
  score += Math.min(30, (liq / Math.max(minLiq, 1)) * 15);
  const v5 = num(snap.volume.m5);
  score += Math.min(25, (v5 / Math.max(liq, 1)) * 100);
  const { buys, sells } = snap.txns.m5;
  const flow = buys + sells;
  if (flow > 0) score += Math.min(20, (buys / flow) * 30);
  if (snap.uniqueTraders5m !== null) score += Math.min(15, snap.uniqueTraders5m / 2);
  const ageSec = (now - poolCreatedAt) / 1000;
  if (ageSec < trading.minPoolAgeSec) notes.push('pool too young');
  if (ageSec > trading.maxPoolAgeSec) notes.push('pool too old');
  if (liq < minLiq) notes.push('liquidity below minimum');
  if (flow === 0) notes.push('no recent trades');
  score += ageSec >= trading.minPoolAgeSec && ageSec <= trading.maxPoolAgeSec ? 10 : 0;
  return { score: Math.round(Math.max(0, Math.min(100, score))), notes };
}
