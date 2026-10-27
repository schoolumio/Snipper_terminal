import { d, s } from '../../decimal';
import { newId } from '../../util/ids';
import { Rng } from '../../util/rng';
import type { ChainId, LpLockInfo, MarketSnapshot, PoolInfo, Quote, QuoteRequest, SecurityReport } from '../../types';
import { ProviderError, type MarketDataProvider, type QuoteProvider, type SecurityProvider } from '../providers';

/**
 * SIMULATED MARKET — synthetic data only.
 *
 * A seeded, deterministic market of constant-product (x·y=k) pools used for
 * paper trading demos, tests and backtests when no real provider is
 * configured. Every pool has a hidden archetype (organic, runner, rug,
 * honeypot, wash, dud) that drives order flow, and a security profile that
 * is only partially observable through `assess()`, so the risk guard has to
 * cope with false negatives and unknowns exactly as it would with real data.
 *
 * Nothing produced here describes a real token, price or trade.
 */

export type Archetype = 'organic' | 'runner' | 'rug' | 'honeypot' | 'wash' | 'dud';

interface Bucket {
  t: number;
  buys: number;
  sells: number;
  volBuy: number;
  volSell: number;
  traders: number;
}

interface SimPool {
  info: PoolInfo;
  archetype: Archetype;
  reserveToken: number;
  reserveQuote: number;
  supply: number;
  feeRate: number;
  baseRate: number;
  bias: number;
  sizeFrac: number;
  peakAt: number;
  rugAt: number | null;
  rugged: boolean;
  holders: number;
  lastStep: number;
  lastQuotedAt: number;
  buckets: Bucket[];
  prices: [number, number][];
  liquidityHistory: [number, number][];
  observed: Omit<SecurityReport, 'fetchedAt' | 'holderCount'>;
}

export interface SimulatedMarketOptions {
  seed: number;
  chain?: ChainId;
  /** Mean seconds between new pool launches. */
  launchEverySec?: number;
  /** Probability that any single data request fails (exercise error paths). */
  failureRate?: number;
  /** Simulation step in ms. */
  stepMs?: number;
  /** Base network fee in quote terms. */
  networkFeeQuote?: number;
  maxPools?: number;
  startAt?: number;
}

const SYLLABLES = ['ZAP', 'MOO', 'KITE', 'BLIP', 'NOVA', 'GLUM', 'PIX', 'FROG', 'ORB', 'DUSK', 'VOLT', 'RUNE', 'BOLT', 'MINT', 'HALO', 'JINX', 'LUX', 'QUAK', 'SNEK', 'TOAD', 'WISP', 'YETI', 'ZEN', 'FUZZ', 'GRIT', 'HOOT', 'KOI', 'MOSS', 'NEON', 'PLUM'];
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BUCKET_MS = 10_000;
const HOUR = 3_600_000;

export class SimulatedMarket implements MarketDataProvider, QuoteProvider, SecurityProvider {
  readonly name = 'simulated';
  readonly simulated = true;
  readonly chain: ChainId;
  private rng: Rng;
  private pools = new Map<string, SimPool>();
  private lastTs: number;
  private readonly launchEverySec: number;
  private readonly stepMs: number;
  private readonly networkFee: number;
  private readonly maxPools: number;
  failureRate: number;
  /** When true every request fails — used to exercise provider-outage handling. */
  outage = false;

  constructor(opts: SimulatedMarketOptions) {
    this.rng = new Rng(opts.seed);
    this.chain = opts.chain ?? 'simnet';
    this.launchEverySec = opts.launchEverySec ?? 30;
    this.failureRate = opts.failureRate ?? 0.002;
    this.stepMs = opts.stepMs ?? 2000;
    this.networkFee = opts.networkFeeQuote ?? 0.001;
    this.maxPools = opts.maxPools ?? 160;
    this.lastTs = opts.startAt ?? Date.now();
  }

  // ───────────── lifecycle ─────────────

  async poll(now: number): Promise<void> {
    this.advance(now);
  }

  advance(now: number): void {
    if (now <= this.lastTs) return;
    // After long downtime only simulate the last 10 minutes.
    if (now - this.lastTs > 10 * 60_000) this.lastTs = now - 10 * 60_000;
    while (this.lastTs + this.stepMs <= now) {
      this.lastTs += this.stepMs;
      this.step(this.lastTs);
    }
  }

  private step(t: number): void {
    const dt = this.stepMs / 1000;
    const launches = this.rng.poisson(dt / this.launchEverySec);
    for (let i = 0; i < launches; i++) this.launch(t);
    for (const p of this.pools.values()) this.stepPool(p, t, dt);
    if (this.pools.size > this.maxPools || this.rng.chance(0.01)) this.prune(t);
  }

  private prune(t: number): void {
    for (const [addr, p] of this.pools) {
      const age = t - p.info.createdAt;
      const recentlyQuoted = t - p.lastQuotedAt < 30 * 60_000;
      const dead = p.rugged || this.volumeSince(p, t, 5 * 60_000) < 50;
      if (!recentlyQuoted && ((age > 30 * 60_000 && dead) || age > 3 * HOUR)) this.pools.delete(addr);
    }
    while (this.pools.size > this.maxPools) {
      const oldest = [...this.pools.values()].filter((p) => t - p.lastQuotedAt > 30 * 60_000).sort((a, b) => a.info.createdAt - b.info.createdAt)[0];
      if (!oldest) break;
      this.pools.delete(oldest.info.address);
    }
  }

  private addr(prefix: string): string {
    let out = prefix;
    while (out.length < 44) out += B58[Math.floor(this.rng.next() * B58.length)];
    return out;
  }

  private launch(t: number): void {
    const r = this.rng;
    const archetype = pickWeighted<Archetype>(r, [
      ['organic', 26],
      ['runner', 7],
      ['rug', 22],
      ['honeypot', 10],
      ['wash', 10],
      ['dud', 25],
    ]);
    const symbol = r.pick(SYLLABLES) + (r.chance(0.5) ? r.pick(SYLLABLES).slice(0, 2) : '');
    const quoteLiquidity = archetype === 'dud' ? r.range(1500, 9000) : r.range(6000, 60000);
    const startPrice = r.range(0.00001, 0.002);
    const reserveQuote = quoteLiquidity / 2;
    const reserveToken = reserveQuote / startPrice;
    const supply = reserveToken * r.range(1.4, 5);
    const tokenAddr = this.addr('Sim');
    const poolAddr = this.addr('Pool');
    const info: PoolInfo = {
      chain: this.chain,
      address: poolAddr,
      dex: 'sim-amm',
      token: { chain: this.chain, address: tokenAddr, symbol, name: `${symbol} (simulated)`, decimals: 6 },
      quoteSymbol: 'USDC',
      quoteAddress: 'SimQuoteUSDC',
      createdAt: t,
      discoveredAt: t,
      source: this.name,
    };
    const p: SimPool = {
      info,
      archetype,
      reserveToken,
      reserveQuote,
      supply,
      feeRate: 0.0025,
      baseRate: archetype === 'wash' ? r.range(1.5, 3) : archetype === 'dud' ? r.range(0.05, 0.2) : r.range(0.3, 1.2),
      bias: archetype === 'runner' ? r.range(0.04, 0.1) : archetype === 'rug' ? r.range(0.04, 0.1) : archetype === 'dud' ? -0.03 : archetype === 'organic' ? r.range(-0.05, 0.04) : 0,
      sizeFrac: archetype === 'wash' ? 0.0008 : 0.0025,
      peakAt: t + r.range(4, 25) * 60_000,
      rugAt: archetype === 'rug' ? t + r.range(2, 20) * 60_000 : null,
      rugged: false,
      holders: r.int(5, 40),
      lastStep: t,
      lastQuotedAt: 0,
      buckets: [],
      prices: [[t, startPrice]],
      liquidityHistory: [[t, quoteLiquidity]],
      observed: this.observedSecurity(archetype, tokenAddr),
    };
    this.pools.set(poolAddr, p);
  }

  /** What a security provider would be able to observe, including noise and gaps. */
  private observedSecurity(a: Archetype, tokenAddress: string): SimPool['observed'] {
    const r = this.rng;
    const unknown = <T>(v: T, p: number): T | null => (r.chance(p) ? null : v);
    const bad = a === 'rug' || a === 'honeypot';
    const mintRenounced = bad ? r.chance(0.55) : r.chance(0.92);
    const freezeRenounced = a === 'honeypot' ? r.chance(0.5) : r.chance(0.96);
    const top10 = bad ? r.range(30, 80) : a === 'wash' ? r.range(35, 70) : r.range(12, 45);
    const creator = bad ? r.range(4, 30) : r.range(0, 9);
    let sellOk: boolean | null;
    if (a === 'honeypot') sellOk = r.chance(0.85) ? false : r.chance(0.6) ? null : true;
    else sellOk = r.chance(0.07) ? null : true;
    const lpClaimed = bad ? r.chance(0.6) : r.chance(0.5);
    const lpVerified = lpClaimed ? (bad ? false : r.chance(0.7)) : null;
    const lpLock: LpLockInfo = {
      claimed: lpClaimed,
      verified: lpVerified,
      lockedPct: lpClaimed ? s(r.range(50, 100), 2) : null,
      unlockAt: null,
      evidence: lpVerified ? 'simulated lock record' : null,
    };
    return {
      chain: this.chain,
      tokenAddress,
      source: this.name,
      mintAuthorityRenounced: unknown(mintRenounced, 0.04),
      freezeAuthorityRenounced: unknown(freezeRenounced, 0.04),
      top10HolderPct: unknown(s(top10, 2), 0.08),
      creatorHoldingPct: unknown(s(creator, 2), 0.1),
      lpLock,
      sellSimulationOk: sellOk,
      transferTaxPct: unknown(a === 'honeypot' && r.chance(0.3) ? s(r.range(5, 25), 2) : '0', 0.05),
      creatorPriorFlaggedTokens: unknown(a === 'rug' ? (r.chance(0.5) ? r.int(1, 4) : 0) : 0, 0.1),
      knownMalicious: unknown(a === 'rug' ? r.chance(0.2) : false, 0.05),
      providerFlags: [],
    };
  }

  private bucket(p: SimPool, t: number): Bucket {
    const bt = Math.floor(t / BUCKET_MS) * BUCKET_MS;
    let b = p.buckets[p.buckets.length - 1];
    if (!b || b.t !== bt) {
      b = { t: bt, buys: 0, sells: 0, volBuy: 0, volSell: 0, traders: 0 };
      p.buckets.push(b);
      if (p.buckets.length > 360) p.buckets.splice(0, p.buckets.length - 360);
    }
    return b;
  }

  private stepPool(p: SimPool, t: number, dt: number): void {
    const r = this.rng;
    const age = t - p.info.createdAt;
    if (p.rugAt !== null && !p.rugged && t >= p.rugAt) {
      // Liquidity pulled.
      p.reserveQuote *= 0.03;
      p.reserveToken *= 0.03;
      p.rugged = true;
    }
    let bias = p.bias;
    if (p.archetype === 'runner' && t > p.peakAt) bias = -0.12;
    // Organic flow mean-reverts towards a slight sell bias as early buyers take profit.
    if (p.archetype === 'organic' && r.chance(0.02)) p.bias = Math.max(-0.1, Math.min(0.08, p.bias * 0.8 - 0.01 + r.normal() * 0.03));
    if (p.rugged) bias = -0.2;
    const decay = Math.exp(-age / (p.archetype === 'wash' ? 4 * HOUR : 50 * 60_000));
    const rate = p.baseRate * decay * (p.rugged ? 0.05 : 1);
    const n = r.poisson(rate * dt);
    const b = this.bucket(p, t);
    for (let i = 0; i < n; i++) {
      const pBuy = Math.max(0.05, Math.min(0.95, 0.5 + bias + r.normal() * 0.05));
      const isBuy = p.archetype === 'honeypot' ? r.chance(0.97) : r.chance(pBuy);
      const sizeQuote = Math.min(Math.exp(r.normal() * 0.9) * p.reserveQuote * p.sizeFrac * 2, p.reserveQuote * 0.08);
      if (sizeQuote <= 0) continue;
      if (isBuy) {
        const inEff = sizeQuote * (1 - p.feeRate);
        const out = (p.reserveToken * inEff) / (p.reserveQuote + inEff);
        p.reserveQuote += sizeQuote;
        p.reserveToken -= out;
        b.buys++;
        b.volBuy += sizeQuote;
        if (p.archetype !== 'wash' && r.chance(0.55)) p.holders++;
      } else {
        const price = p.reserveQuote / p.reserveToken;
        const tokensIn = sizeQuote / price;
        const outGross = (p.reserveQuote * tokensIn) / (p.reserveToken + tokensIn);
        p.reserveToken += tokensIn;
        p.reserveQuote -= outGross;
        b.sells++;
        b.volSell += outGross;
        if (p.archetype !== 'wash' && r.chance(0.2)) p.holders = Math.max(1, p.holders - 1);
      }
      b.traders += p.archetype === 'wash' ? (r.chance(0.1) ? 1 : 0) : r.chance(0.75) ? 1 : 0;
    }
    // Runners / organics attract extra liquidity early on.
    if ((p.archetype === 'runner' || (p.archetype === 'organic' && p.bias > 0.03)) && age < 15 * 60_000 && r.chance(0.01)) {
      const k = 1 + r.range(0.05, 0.25);
      p.reserveQuote *= k;
      p.reserveToken *= k;
    }
    p.lastStep = t;
    const lastPrice = p.prices[p.prices.length - 1];
    if (!lastPrice || t - lastPrice[0] >= BUCKET_MS) {
      p.prices.push([t, p.reserveQuote / p.reserveToken]);
      p.liquidityHistory.push([t, 2 * p.reserveQuote]);
      if (p.prices.length > 400) p.prices.splice(0, p.prices.length - 400);
      if (p.liquidityHistory.length > 400) p.liquidityHistory.splice(0, p.liquidityHistory.length - 400);
    }
  }

  private volumeSince(p: SimPool, t: number, windowMs: number): number {
    let v = 0;
    for (const b of p.buckets) if (b.t > t - windowMs) v += b.volBuy + b.volSell;
    return v;
  }

  private maybeFail(op: string): void {
    if (this.outage) throw new ProviderError(this.name, `${op}: provider unavailable (simulated outage)`);
    if (this.rng.chance(this.failureRate)) throw new ProviderError(this.name, `${op}: transient error (simulated)`);
  }

  private pool(address: string): SimPool {
    const p = this.pools.get(address);
    if (!p) throw new ProviderError(this.name, `unknown pool ${address}`, false);
    return p;
  }

  // ───────────── MarketDataProvider ─────────────

  async discoverPools(since: number, now: number): Promise<PoolInfo[]> {
    this.advance(now);
    this.maybeFail('discoverPools');
    return [...this.pools.values()].filter((p) => p.info.createdAt > since && p.info.createdAt <= now).map((p) => ({ ...p.info, discoveredAt: now }));
  }

  async getSnapshot(pool: PoolInfo, now: number): Promise<MarketSnapshot> {
    this.advance(now);
    this.maybeFail('getSnapshot');
    const p = this.pool(pool.address);
    const t = p.lastStep;
    const agg = (windowMs: number) => {
      let buys = 0,
        sells = 0,
        vol = 0,
        traders = 0;
      for (const b of p.buckets) {
        if (b.t + BUCKET_MS > t - windowMs) {
          buys += b.buys;
          sells += b.sells;
          vol += b.volBuy + b.volSell;
          traders += b.traders;
        }
      }
      return { buys, sells, vol, traders };
    };
    const m1 = agg(60_000);
    const m5 = agg(5 * 60_000);
    const h1 = agg(HOUR);
    const price = p.reserveQuote / p.reserveToken;
    const priceAt = (ago: number): number | null => {
      const target = t - ago;
      if (p.info.createdAt > target) return null;
      let best: [number, number] | undefined;
      for (const x of p.prices) if (x[0] <= target) best = x;
      return best ? best[1] : null;
    };
    const chg = (ago: number) => {
      const old = priceAt(ago);
      return old ? s(((price - old) / old) * 100, 4) : null;
    };
    return {
      chain: this.chain,
      poolAddress: p.info.address,
      tokenAddress: p.info.token.address,
      ts: t,
      fetchedAt: now,
      source: this.name,
      price: s(price, 12),
      liquidity: s(2 * p.reserveQuote, 6),
      marketCap: s(price * p.supply, 2),
      volume: { m1: s(m1.vol, 4), m5: s(m5.vol, 4), h1: s(h1.vol, 4) },
      txns: { m5: { buys: m5.buys, sells: m5.sells }, h1: { buys: h1.buys, sells: h1.sells } },
      priceChange: { m1: chg(60_000), m5: chg(5 * 60_000), h1: chg(HOUR) },
      holders: p.holders,
      uniqueTraders5m: m5.traders,
    };
  }

  // ───────────── QuoteProvider ─────────────

  async getQuote(req: QuoteRequest, now: number): Promise<Quote> {
    this.advance(now);
    this.maybeFail('getQuote');
    const p = this.pool(req.poolAddress);
    p.lastQuotedAt = now;
    const q = ammQuote(p.reserveToken, p.reserveQuote, p.feeRate, req.side, req.amountIn);
    return {
      id: newId('qt', now),
      chain: this.chain,
      poolAddress: req.poolAddress,
      tokenAddress: req.tokenAddress,
      side: req.side,
      amountIn: req.amountIn,
      ...q,
      networkFeeQuote: s(this.networkFee, 8),
      ts: now,
      expiresAt: now + 10_000,
      source: this.name,
    };
  }

  // ───────────── SecurityProvider ─────────────

  async assess(_chain: ChainId, tokenAddress: string, pool: PoolInfo, now: number): Promise<SecurityReport> {
    this.maybeFail('assess');
    const p = this.pool(pool.address);
    if (p.info.token.address !== tokenAddress) throw new ProviderError(this.name, 'token / pool mismatch', false);
    return { ...p.observed, providerFlags: [...p.observed.providerFlags], fetchedAt: now, holderCount: p.holders };
  }

  // ───────────── swap venue (used only by the paper executor) ─────────────

  /** Apply a swap to the simulated pool. Throws on honeypot sells or minOut violations. */
  executeSwap(req: QuoteRequest & { minOut: string }, now: number): { amountOut: string } {
    this.advance(now);
    const p = this.pool(req.poolAddress);
    p.lastQuotedAt = now;
    if (req.side === 'sell' && p.archetype === 'honeypot') throw new ProviderError(this.name, 'transfer restricted by token program', false);
    const q = ammQuote(p.reserveToken, p.reserveQuote, p.feeRate, req.side, req.amountIn);
    if (d(q.expectedOut).lt(req.minOut)) throw new ProviderError(this.name, `slippage exceeded: out ${q.expectedOut} < min ${req.minOut}`, false);
    const amtIn = Number(req.amountIn);
    const out = Number(q.expectedOut);
    if (req.side === 'buy') {
      p.reserveQuote += amtIn;
      p.reserveToken -= out;
    } else {
      p.reserveToken += amtIn;
      p.reserveQuote -= out / (1 - p.feeRate);
    }
    return { amountOut: q.expectedOut };
  }

  /** Dry-run a swap without changing state (like an RPC transaction simulation). */
  simulateSwap(req: QuoteRequest & { minOut: string }, now: number): { ok: boolean; expectedOut: string | null; error: string | null } {
    this.advance(now);
    const p = this.pools.get(req.poolAddress);
    if (!p) return { ok: false, expectedOut: null, error: 'unknown pool' };
    if (req.side === 'sell' && p.archetype === 'honeypot') return { ok: false, expectedOut: null, error: 'transfer restricted by token program' };
    const q = ammQuote(p.reserveToken, p.reserveQuote, p.feeRate, req.side, req.amountIn);
    if (d(q.expectedOut).lt(req.minOut)) return { ok: false, expectedOut: q.expectedOut, error: 'slippage exceeded' };
    return { ok: true, expectedOut: q.expectedOut, error: null };
  }

  // ───────────── inspection / persistence ─────────────

  get now(): number {
    return this.lastTs;
  }

  archetypeOf(poolAddress: string): Archetype | null {
    return this.pools.get(poolAddress)?.archetype ?? null;
  }

  poolCount(): number {
    return this.pools.size;
  }

  serialize(keepPools: Set<string>): string {
    const pools = [...this.pools.values()].filter((p) => keepPools.has(p.info.address));
    return JSON.stringify({ v: 1, rng: this.rng.state, lastTs: this.lastTs, pools });
  }

  restore(json: string): void {
    const data = JSON.parse(json) as { v: number; rng: number; lastTs: number; pools: SimPool[] };
    if (data.v !== 1) throw new Error('unsupported simulated market snapshot');
    this.rng = new Rng(data.rng);
    this.lastTs = Math.max(this.lastTs, data.lastTs);
    for (const p of data.pools) this.pools.set(p.info.address, p);
  }
}

function pickWeighted<T>(r: Rng, items: [T, number][]): T {
  const total = items.reduce((a, [, w]) => a + w, 0);
  let x = r.next() * total;
  for (const [v, w] of items) {
    x -= w;
    if (x <= 0) return v;
  }
  return items[items.length - 1]![0];
}

/** Constant-product quote with Decimal math. */
export function ammQuote(
  reserveToken: number | string,
  reserveQuote: number | string,
  feeRate: number | string,
  side: 'buy' | 'sell',
  amountIn: string,
): Pick<Quote, 'expectedOut' | 'midPrice' | 'effectivePrice' | 'priceImpactPct' | 'swapFeeQuote'> {
  const rt = d(reserveToken);
  const rq = d(reserveQuote);
  const fee = d(feeRate);
  const amt = d(amountIn);
  if (amt.lte(0)) throw new Error('amountIn must be positive');
  const mid = rq.div(rt);
  if (side === 'buy') {
    const feeAmt = amt.times(fee);
    const inEff = amt.minus(feeAmt);
    const out = rt.times(inEff).div(rq.plus(inEff));
    const effNoFee = inEff.div(out);
    return {
      expectedOut: s(out, 12),
      midPrice: s(mid, 18),
      effectivePrice: s(amt.div(out), 18),
      priceImpactPct: s(effNoFee.div(mid).minus(1).times(100), 6),
      swapFeeQuote: s(feeAmt, 12),
    };
  }
  const outGross = rq.times(amt).div(rt.plus(amt));
  const feeAmt = outGross.times(fee);
  const out = outGross.minus(feeAmt);
  return {
    expectedOut: s(out, 12),
    midPrice: s(mid, 18),
    effectivePrice: s(out.div(amt), 18),
    priceImpactPct: s(d(1).minus(outGross.div(amt).div(mid)).times(100), 6),
    swapFeeQuote: s(feeAmt, 12),
  };
}
