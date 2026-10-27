import type { EngineConfig, HardLimits } from '../config';
import { Engine } from '../engine';
import { PaperExecutionAdapter } from '../execution/paper-adapter';
import { SimulatedMarket } from '../market/sim/simulated-market';
import { MemoryStore } from '../store/memory-store';
import type { BacktestRunSummary, Trade } from '../types';
import { newId } from '../util/ids';

export interface BacktestParams {
  seed: number;
  durationSec: number;
  startingEquity: string;
  config: EngineConfig;
  configVersion: number;
  hardLimits: HardLimits;
  /** Simulated wall-clock start. */
  startAt?: number;
  tickMs?: number;
  txFailureRate?: number;
  onProgress?: (fraction: number) => void;
}

/**
 * Event-driven backtest on the SIMULATED market.
 *
 * The full production pipeline (scanner → risk → strategy → sizer → executor →
 * exit manager → accountant) runs in virtual time. Avoids look-ahead bias by
 * construction — at time t the engine can only observe market state produced
 * up to t — and avoids instantaneous fills: orders settle after simulated
 * latency against the moved pool, with failures and fees. Results describe a
 * synthetic market only and say nothing about real-world profitability.
 */
export async function runSimulatedBacktest(p: BacktestParams): Promise<{ run: BacktestRunSummary; trades: Trade[] }> {
  const startAt = p.startAt ?? Date.UTC(2026, 0, 1);
  const tickMs = p.tickMs ?? 1000;
  const market = new SimulatedMarket({ seed: p.seed, startAt: startAt - 30 * 60_000, failureRate: 0.001 });
  // Warm up so pools exist at t0.
  market.advance(startAt);
  const paper = new PaperExecutionAdapter({ chain: market.chain, quotes: market, venue: market, seed: p.seed ^ 0x5eed, failureRate: p.txFailureRate ?? 0.03 });
  const store = new MemoryStore();
  const cfg = structuredClone(p.config);
  cfg.trading.chain = market.chain;
  const engine = new Engine(
    {
      store,
      market,
      quotes: market,
      security: [market],
      paperAdapter: paper,
      liveAdapter: null,
      hardLimits: p.hardLimits,
      defaultConfig: cfg,
      options: { paperStartingEquity: p.startingEquity, equitySnapshotEveryMs: 60_000 },
    },
    startAt,
  );
  const run: BacktestRunSummary = {
    id: newId('bt'),
    createdAt: Date.now(),
    status: 'running',
    dataSource: 'simulated-market',
    seed: p.seed,
    durationSec: p.durationSec,
    configVersion: p.configVersion,
    stats: null,
    equityCurve: [],
    error: null,
    notes: 'Synthetic constant-product market with hidden token archetypes (incl. rugs and honeypots). Not real market data.',
  };
  try {
    await engine.init(startAt);
    const end = startAt + p.durationSec * 1000;
    let i = 0;
    for (let t = startAt; t <= end; t += tickMs) {
      await engine.tick(t);
      if (p.onProgress && ++i % 300 === 0) {
        p.onProgress((t - startAt) / (end - startAt));
        await new Promise((r) => setImmediate(r));
      }
    }
    run.stats = engine.performanceFor('paper');
    run.equityCurve = engine.equitySeries('paper').map((e) => ({ ts: e.ts, equity: e.equity }));
    run.status = 'completed';
  } catch (e) {
    run.status = 'failed';
    run.error = e instanceof Error ? e.message : String(e);
  }
  return { run, trades: [...store.trades.values()].sort((a, b) => a.exitAt - b.exitAt) };
}
