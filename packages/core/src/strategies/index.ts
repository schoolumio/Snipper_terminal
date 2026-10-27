import type { StrategyParams } from '../config';
import { num } from '../decimal';
import type { MarketSnapshot, PoolInfo, RiskVerdict, StrategyId } from '../types';

export interface StrategyContext {
  pool: PoolInfo;
  snapshot: MarketSnapshot;
  /** Prior snapshots for this pool, oldest first (excludes `snapshot`). */
  history: MarketSnapshot[];
  now: number;
  params: StrategyParams;
  risk: { verdict: RiskVerdict; score: number; confidence: number };
}

export type StrategyResult =
  | {
      kind: 'signal';
      score: number;
      confidence: number;
      rationale: string;
      entryConditions: string[];
      invalidation: string[];
      metrics: Record<string, number | string | null>;
    }
  | { kind: 'skip'; reason: string; metrics: Record<string, number | string | null> };

export interface Strategy {
  readonly id: StrategyId;
  readonly version: string;
  readonly label: string;
  evaluate(ctx: StrategyContext): StrategyResult;
}

export interface Features {
  ageSec: number;
  price: number;
  liquidity: number;
  vol1m: number;
  vol5m: number;
  avg5mVolLastHour: number;
  volSpike: number;
  buySell5m: number;
  chg1m: number | null;
  chg5m: number | null;
  chg1h: number | null;
  liqGrowthPct: number | null;
  recentHigh: number | null;
  retraceFromHighPct: number | null;
  historyLen: number;
}

export function features(ctx: StrategyContext, lookback = 20): Features {
  const s = ctx.snapshot;
  const price = num(s.price);
  const liquidity = num(s.liquidity);
  const vol5m = num(s.volume.m5);
  const vol1h = num(s.volume.h1);
  const ageSec = Math.max(0, (s.ts - ctx.pool.createdAt) / 1000);
  // Average 5m volume over the part of the last hour that exists.
  const windows = Math.max(1, Math.min(12, ageSec / 300));
  const avg5m = vol1h / windows;
  const { buys, sells } = s.txns.m5;
  const hist = ctx.history.slice(-lookback);
  const highs = hist.map((h) => num(h.price));
  const recentHigh = highs.length ? Math.max(...highs) : null;
  const firstLiq = ctx.history.length ? num(ctx.history[0]!.liquidity) : null;
  return {
    ageSec,
    price,
    liquidity,
    vol1m: num(s.volume.m1),
    vol5m,
    avg5mVolLastHour: avg5m,
    volSpike: avg5m > 0 ? num(s.volume.m1) * 5 / avg5m : 0,
    buySell5m: sells === 0 ? (buys > 0 ? buys : 0) : buys / sells,
    chg1m: s.priceChange.m1 === null ? null : num(s.priceChange.m1),
    chg5m: s.priceChange.m5 === null ? null : num(s.priceChange.m5),
    chg1h: s.priceChange.h1 === null ? null : num(s.priceChange.h1),
    liqGrowthPct: firstLiq && firstLiq > 0 ? ((liquidity - firstLiq) / firstLiq) * 100 : null,
    recentHigh,
    retraceFromHighPct: recentHigh && recentHigh > 0 ? ((recentHigh - price) / recentHigh) * 100 : null,
    historyLen: ctx.history.length,
  };
}

const clamp = (x: number, a = 0, b = 100) => Math.max(a, Math.min(b, x));
const r2 = (x: number | null) => (x === null ? null : Math.round(x * 100) / 100);

function baseConfidence(f: Features, minHistory: number): number {
  const histPart = Math.min(1, f.historyLen / minHistory);
  const dataPart = [f.chg1m, f.chg5m].filter((x) => x !== null).length / 2;
  return Math.round((0.4 + 0.35 * histPart + 0.25 * dataPart) * 100) / 100;
}

const metricsOf = (f: Features) => ({
  ageSec: Math.round(f.ageSec),
  buySell5m: r2(f.buySell5m),
  vol5m: r2(f.vol5m),
  volSpike: r2(f.volSpike),
  chg1m: r2(f.chg1m),
  chg5m: r2(f.chg5m),
  liqGrowthPct: r2(f.liqGrowthPct),
  retraceFromHighPct: r2(f.retraceFromHighPct),
});

export const newPoolEntry: Strategy = {
  id: 'new_pool_entry',
  version: '1.0.0',
  label: 'New liquidity-pool entry',
  evaluate(ctx) {
    const p = ctx.params.new_pool_entry;
    const f = features(ctx);
    const m = metricsOf(f);
    if (f.ageSec < p.minAgeSec) return { kind: 'skip', reason: `pool ${f.ageSec.toFixed(0)}s old, waiting for ${p.minAgeSec}s`, metrics: m };
    if (f.ageSec > p.maxAgeSec) return { kind: 'skip', reason: 'pool past new-launch window', metrics: m };
    if (f.buySell5m < num(p.minBuySellRatio)) return { kind: 'skip', reason: `buy/sell ${f.buySell5m.toFixed(2)} < ${p.minBuySellRatio}`, metrics: m };
    if (f.vol5m < num(p.minVolume5m)) return { kind: 'skip', reason: `5m volume ${f.vol5m.toFixed(0)} < ${p.minVolume5m}`, metrics: m };
    if (f.chg5m !== null && f.chg5m > num(p.maxChasePct)) return { kind: 'skip', reason: `already +${f.chg5m.toFixed(1)}% in 5m (chase cap ${p.maxChasePct}%)`, metrics: m };
    if (f.chg1m !== null && f.chg1m < -5) return { kind: 'skip', reason: `falling ${f.chg1m.toFixed(1)}% in last minute`, metrics: m };
    const score = clamp(40 + (f.buySell5m - 1) * 25 + Math.min(20, (f.vol5m / Math.max(f.liquidity, 1)) * 60) + (f.chg5m ?? 0) * 0.3);
    return {
      kind: 'signal',
      score: Math.round(score),
      confidence: baseConfidence(f, 3),
      rationale: `new pool ${Math.round(f.ageSec / 60)}m old · buy/sell ${f.buySell5m.toFixed(2)} · 5m vol ${f.vol5m.toFixed(0)}`,
      entryConditions: [`pool age ${p.minAgeSec}-${p.maxAgeSec}s`, `buy/sell ≥ ${p.minBuySellRatio}`, `5m volume ≥ ${p.minVolume5m}`],
      invalidation: ['buy/sell ratio falls below 1', 'liquidity drops', `price falls below stop`],
      metrics: m,
    };
  },
};

export const volumeSpike: Strategy = {
  id: 'volume_spike',
  version: '1.0.0',
  label: 'Volume-spike momentum',
  evaluate(ctx) {
    const p = ctx.params.volume_spike;
    const f = features(ctx);
    const m = metricsOf(f);
    if (f.ageSec < 300) return { kind: 'skip', reason: 'needs ≥5m of history for a volume baseline', metrics: m };
    if (f.volSpike < num(p.spikeMultiple)) return { kind: 'skip', reason: `volume ${f.volSpike.toFixed(1)}× baseline < ${p.spikeMultiple}×`, metrics: m };
    if (f.chg5m === null || f.chg5m < num(p.minPriceChange5mPct)) return { kind: 'skip', reason: 'spike without upward price confirmation', metrics: m };
    if (f.chg5m > num(p.maxPriceChange5mPct)) return { kind: 'skip', reason: `move already +${f.chg5m.toFixed(1)}%`, metrics: m };
    if (f.buySell5m < 1) return { kind: 'skip', reason: 'spike is sell-dominated', metrics: m };
    const score = clamp(45 + (f.volSpike - num(p.spikeMultiple)) * 8 + f.chg5m * 0.5 + (f.buySell5m - 1) * 15);
    return {
      kind: 'signal',
      score: Math.round(score),
      confidence: baseConfidence(f, 5),
      rationale: `volume ${f.volSpike.toFixed(1)}× 1h baseline · +${f.chg5m.toFixed(1)}% 5m · buy/sell ${f.buySell5m.toFixed(2)}`,
      entryConditions: [`1m volume ≥ ${p.spikeMultiple}× baseline`, `5m change ${p.minPriceChange5mPct}–${p.maxPriceChange5mPct}%`],
      invalidation: ['volume returns to baseline with falling price', 'sell pressure dominates'],
      metrics: m,
    };
  },
};

export const priceBreakout: Strategy = {
  id: 'price_breakout',
  version: '1.0.0',
  label: 'Price breakout',
  evaluate(ctx) {
    const p = ctx.params.price_breakout;
    const f = features(ctx, p.lookbackSnapshots);
    const m = metricsOf(f);
    if (f.historyLen < Math.min(6, p.lookbackSnapshots)) return { kind: 'skip', reason: 'insufficient price history for breakout', metrics: m };
    if (f.recentHigh === null) return { kind: 'skip', reason: 'no recent high', metrics: m };
    const over = ((f.price - f.recentHigh) / f.recentHigh) * 100;
    if (over < num(p.breakoutPct)) return { kind: 'skip', reason: `price ${over.toFixed(1)}% vs recent high (needs +${p.breakoutPct}%)`, metrics: m };
    const volRatio = f.avg5mVolLastHour > 0 ? f.vol5m / f.avg5mVolLastHour : 0;
    if (volRatio < num(p.minVolumeRatio)) return { kind: 'skip', reason: `breakout lacks volume (${volRatio.toFixed(2)}×)`, metrics: m };
    const score = clamp(45 + over * 2 + (volRatio - 1) * 15 + (f.buySell5m - 1) * 10);
    return {
      kind: 'signal',
      score: Math.round(score),
      confidence: baseConfidence(f, p.lookbackSnapshots),
      rationale: `broke ${p.lookbackSnapshots}-sample high by ${over.toFixed(1)}% on ${volRatio.toFixed(1)}× volume`,
      entryConditions: [`price > recent high +${p.breakoutPct}%`, `5m volume ≥ ${p.minVolumeRatio}× average`],
      invalidation: ['price closes back below prior high'],
      metrics: { ...m, breakoutPct: r2(over), volRatio: r2(volRatio) },
    };
  },
};

export const pullbackEntry: Strategy = {
  id: 'pullback_entry',
  version: '1.0.0',
  label: 'Pullback entry',
  evaluate(ctx) {
    const p = ctx.params.pullback_entry;
    const f = features(ctx, 40);
    const m = metricsOf(f);
    if (f.historyLen < 8 || f.retraceFromHighPct === null) return { kind: 'skip', reason: 'insufficient history for pullback', metrics: m };
    if (f.retraceFromHighPct < num(p.minRetracePct)) return { kind: 'skip', reason: `retrace ${f.retraceFromHighPct.toFixed(1)}% < ${p.minRetracePct}%`, metrics: m };
    if (f.retraceFromHighPct > num(p.maxRetracePct)) return { kind: 'skip', reason: `retrace ${f.retraceFromHighPct.toFixed(1)}% too deep`, metrics: m };
    if (f.buySell5m < num(p.minBuySellRatio)) return { kind: 'skip', reason: 'buyers not stepping in on pullback', metrics: m };
    if (f.chg1m !== null && f.chg1m < 0) return { kind: 'skip', reason: 'still falling — waiting for stabilisation', metrics: m };
    if (f.liqGrowthPct !== null && f.liqGrowthPct < -10) return { kind: 'skip', reason: 'liquidity leaving during pullback', metrics: m };
    const mid = (num(p.minRetracePct) + num(p.maxRetracePct)) / 2;
    const score = clamp(50 + (10 - Math.abs(f.retraceFromHighPct - mid)) + (f.buySell5m - 1) * 20);
    return {
      kind: 'signal',
      score: Math.round(score),
      confidence: baseConfidence(f, 20),
      rationale: `${f.retraceFromHighPct.toFixed(1)}% pullback from high, stabilising with buy/sell ${f.buySell5m.toFixed(2)}`,
      entryConditions: [`retrace ${p.minRetracePct}–${p.maxRetracePct}% from recent high`, '1m change ≥ 0'],
      invalidation: [`retrace exceeds ${p.maxRetracePct}%`, 'liquidity declines'],
      metrics: m,
    };
  },
};

export const liquidityMomentum: Strategy = {
  id: 'liquidity_momentum',
  version: '1.0.0',
  label: 'Liquidity + momentum confirmation',
  evaluate(ctx) {
    const p = ctx.params.liquidity_momentum;
    const f = features(ctx);
    const m = metricsOf(f);
    if (f.liqGrowthPct === null || f.historyLen < 3) return { kind: 'skip', reason: 'no liquidity baseline yet', metrics: m };
    if (f.liqGrowthPct < num(p.minLiquidityGrowthPct)) return { kind: 'skip', reason: `liquidity +${f.liqGrowthPct.toFixed(1)}% < ${p.minLiquidityGrowthPct}%`, metrics: m };
    if (f.chg5m === null || f.chg5m < num(p.minPriceChange5mPct)) return { kind: 'skip', reason: 'no price momentum alongside liquidity growth', metrics: m };
    const score = clamp(45 + f.liqGrowthPct * 0.5 + f.chg5m * 0.6 + (f.buySell5m - 1) * 10);
    return {
      kind: 'signal',
      score: Math.round(score),
      confidence: baseConfidence(f, 6),
      rationale: `liquidity +${f.liqGrowthPct.toFixed(1)}% with +${f.chg5m.toFixed(1)}% 5m momentum`,
      entryConditions: [`liquidity growth ≥ ${p.minLiquidityGrowthPct}%`, `5m change ≥ ${p.minPriceChange5mPct}%`],
      invalidation: ['liquidity withdrawn', 'momentum reverses'],
      metrics: m,
    };
  },
};

export const STRATEGIES: Record<StrategyId, Strategy> = {
  new_pool_entry: newPoolEntry,
  volume_spike: volumeSpike,
  price_breakout: priceBreakout,
  pullback_entry: pullbackEntry,
  liquidity_momentum: liquidityMomentum,
};
