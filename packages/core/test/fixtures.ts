import { DEFAULT_CONFIG, DEFAULT_HARD_LIMITS, type EngineConfig } from '../src/config';
import { s } from '../src/decimal';
import { Engine, type EngineOptions } from '../src/engine';
import { PaperExecutionAdapter, type SwapVenue } from '../src/execution/paper-adapter';
import { ProviderError, type MarketDataProvider, type QuoteProvider, type SecurityProvider } from '../src/market/providers';
import { ammQuote } from '../src/market/sim/simulated-market';
import { MemoryStore } from '../src/store/memory-store';
import type { ChainId, MarketSnapshot, PoolInfo, Quote, QuoteRequest, SecurityReport } from '../src/types';

export const T0 = Date.UTC(2026, 5, 1, 12, 0, 0);

export interface FixturePool {
  info: PoolInfo;
  reserveToken: number;
  reserveQuote: number;
  marketCap: string;
  volume: MarketSnapshot['volume'];
  txns: MarketSnapshot['txns'];
  priceChange: MarketSnapshot['priceChange'];
  holders: number;
  uniqueTraders5m: number;
  report: Omit<SecurityReport, 'fetchedAt'>;
  honeypot: boolean;
}

/**
 * Deterministic, fully scripted market for tests. Prices only move when a
 * test calls `setPrice`; nothing is random.
 */
export class FixtureMarket implements MarketDataProvider, QuoteProvider, SecurityProvider, SwapVenue {
  readonly name = 'fixture';
  readonly chain: ChainId = 'simnet';
  readonly simulated = true;
  pools = new Map<string, FixturePool>();
  outage = false;
  quoteOutage = false;
  securityOutage = false;
  feeRate = 0.0025;

  addPool(symbol: string, createdAt: number, over: Partial<FixturePool> = {}, report: Partial<SecurityReport> = {}): FixturePool {
    const tokenAddr = `Tok${symbol}`.padEnd(32, '1');
    const poolAddr = `Pool${symbol}`.padEnd(32, '1');
    const price = 0.001;
    const reserveQuote = 20_000;
    const p: FixturePool = {
      info: {
        chain: 'simnet',
        address: poolAddr,
        dex: 'fixture',
        token: { chain: 'simnet', address: tokenAddr, symbol, name: symbol, decimals: 6 },
        quoteSymbol: 'USDC',
        quoteAddress: 'USDC',
        createdAt,
        discoveredAt: createdAt,
        source: 'fixture',
      },
      reserveToken: reserveQuote / price,
      reserveQuote,
      marketCap: '400000',
      volume: { m1: '1200', m5: '5000', h1: '9000' },
      txns: { m5: { buys: 40, sells: 20 }, h1: { buys: 80, sells: 40 } },
      priceChange: { m1: '1', m5: '10', h1: null },
      holders: 200,
      uniqueTraders5m: 40,
      honeypot: false,
      report: {
        chain: 'simnet',
        tokenAddress: tokenAddr,
        source: 'fixture',
        mintAuthorityRenounced: true,
        freezeAuthorityRenounced: true,
        top10HolderPct: '20',
        creatorHoldingPct: '2',
        holderCount: 200,
        lpLock: { claimed: true, verified: true, lockedPct: '100', unlockAt: null, evidence: 'fixture' },
        sellSimulationOk: true,
        transferTaxPct: '0',
        creatorPriorFlaggedTokens: 0,
        knownMalicious: false,
        providerFlags: [],
        ...report,
      },
      ...over,
    };
    this.pools.set(poolAddr, p);
    return p;
  }

  setPrice(pool: FixturePool, price: number): void {
    pool.reserveToken = pool.reserveQuote / price;
  }

  price(pool: FixturePool): number {
    return pool.reserveQuote / pool.reserveToken;
  }

  private get(addr: string): FixturePool {
    const p = this.pools.get(addr);
    if (!p) throw new ProviderError(this.name, 'unknown pool', false);
    return p;
  }

  async discoverPools(since: number, now: number): Promise<PoolInfo[]> {
    if (this.outage) throw new ProviderError(this.name, 'outage');
    return [...this.pools.values()].filter((p) => p.info.createdAt > since && p.info.createdAt <= now).map((p) => p.info);
  }

  async getSnapshot(pool: PoolInfo, now: number): Promise<MarketSnapshot> {
    if (this.outage) throw new ProviderError(this.name, 'outage');
    const p = this.get(pool.address);
    return {
      chain: 'simnet',
      poolAddress: p.info.address,
      tokenAddress: p.info.token.address,
      ts: now,
      fetchedAt: now,
      source: this.name,
      price: s(this.price(p), 12),
      liquidity: s(2 * p.reserveQuote, 4),
      marketCap: p.marketCap,
      volume: p.volume,
      txns: p.txns,
      priceChange: p.priceChange,
      holders: p.holders,
      uniqueTraders5m: p.uniqueTraders5m,
    };
  }

  async getQuote(req: QuoteRequest, now: number): Promise<Quote> {
    if (this.outage || this.quoteOutage) throw new ProviderError(this.name, 'quote outage');
    const p = this.get(req.poolAddress);
    return {
      id: `q-${now}-${req.side}`,
      chain: 'simnet',
      poolAddress: req.poolAddress,
      tokenAddress: req.tokenAddress,
      side: req.side,
      amountIn: req.amountIn,
      ...ammQuote(p.reserveToken, p.reserveQuote, this.feeRate, req.side, req.amountIn),
      networkFeeQuote: '0.001',
      ts: now,
      expiresAt: now + 10_000,
      source: this.name,
    };
  }

  async assess(_c: ChainId, tokenAddress: string, pool: PoolInfo, now: number): Promise<SecurityReport> {
    if (this.securityOutage) throw new ProviderError(this.name, 'security outage');
    const p = this.get(pool.address);
    if (p.info.token.address !== tokenAddress) throw new ProviderError(this.name, 'mismatch', false);
    return { ...structuredClone(p.report), fetchedAt: now };
  }

  executeSwap(req: QuoteRequest & { minOut: string }): { amountOut: string } {
    const p = this.get(req.poolAddress);
    if (req.side === 'sell' && p.honeypot) throw new ProviderError(this.name, 'transfer restricted by token program', false);
    const q = ammQuote(p.reserveToken, p.reserveQuote, this.feeRate, req.side, req.amountIn);
    if (Number(q.expectedOut) < Number(req.minOut)) throw new ProviderError(this.name, 'slippage exceeded', false);
    return { amountOut: q.expectedOut };
  }

  simulateSwap(req: QuoteRequest & { minOut: string }): { ok: boolean; expectedOut: string | null; error: string | null } {
    const p = this.get(req.poolAddress);
    if (req.side === 'sell' && p.honeypot) return { ok: false, expectedOut: null, error: 'transfer restricted by token program' };
    const q = ammQuote(p.reserveToken, p.reserveQuote, this.feeRate, req.side, req.amountIn);
    return { ok: Number(q.expectedOut) >= Number(req.minOut), expectedOut: q.expectedOut, error: null };
  }
}

export function testConfig(mut?: (c: EngineConfig) => void): EngineConfig {
  const c = structuredClone(DEFAULT_CONFIG);
  c.trading.enabledStrategies = ['new_pool_entry'];
  c.trading.exitPolicy.momentumReversal.enabled = false;
  mut?.(c);
  return c;
}

export function makeEngine(opts: { market?: FixtureMarket; store?: MemoryStore; config?: EngineConfig; options?: Partial<EngineOptions>; failureRate?: number; now?: number } = {}) {
  const market = opts.market ?? new FixtureMarket();
  const store = opts.store ?? new MemoryStore();
  const paper = new PaperExecutionAdapter({ chain: 'simnet', quotes: market, venue: market, failureRate: opts.failureRate ?? 0, latencyMs: [500, 500] });
  const engine = new Engine(
    {
      store,
      market,
      quotes: market,
      security: [market],
      paperAdapter: paper,
      liveAdapter: null,
      hardLimits: DEFAULT_HARD_LIMITS,
      defaultConfig: opts.config ?? testConfig(),
      options: { paperStartingEquity: '1000', ...opts.options },
    },
    opts.now ?? T0,
  );
  return { engine, market, store, paper };
}

/** Run ticks every `stepMs` from `from` (inclusive) to `to` (inclusive). */
export async function runTicks(engine: Engine, from: number, to: number, stepMs = 1000): Promise<number> {
  let t = from;
  for (; t <= to; t += stepMs) await engine.tick(t);
  return t - stepMs;
}
