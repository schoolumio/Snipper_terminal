import { checkHardLimits, EngineConfigSchema, type EngineConfig, type HardLimits } from './config';
import {
  applyDeposit,
  applyEntryFill,
  applyExitFill,
  applyFailedTx,
  applyWithdrawal,
  applyWriteOff,
  computePerformance,
  equitySnapshot,
  newLedger,
  release,
  reserve,
  touchLedger,
  valuePortfolio,
} from './agents/accountant';
import { AuditLogger, type AuditInput } from './agents/audit-logger';
import { entryPreTradeChecks } from './agents/executor-checks';
import { evaluateExit, initialStop, type ExitReason } from './agents/exit-manager';
import { AgentRegistry } from './agents/registry';
import { evaluateRisk, scannerScore } from './agents/risk-guard';
import { dailyPnlPct, drawdownPct, sizePosition, type PortfolioState, type SizingResult } from './agents/sizer';
import { d, Decimal, max, min, pct, s } from './decimal';
import type { ExecutionAdapter, SwapStatus } from './execution/adapter';
import { mergeSecurityReports, ProviderError, type MarketDataProvider, type QuoteProvider, type SecurityProvider } from './market/providers';
import { isTerminal, transition } from './state-machine';
import type { ConfigVersion, Store, WriteBatch } from './store/store';
import { STRATEGIES } from './strategies';
import type {
  Alert,
  AlertLevel,
  Candidate,
  ChainTransaction,
  CircuitBreakerState,
  DashboardSnapshot,
  EngineEvent,
  EngineStatus,
  EquitySnapshot,
  Ledger,
  MarketSnapshot,
  Order,
  PerformanceStats,
  PipelineCounters,
  PipelineStage,
  PoolInfo,
  Position,
  PositionEvent,
  ProviderHealth,
  Quote,
  RiskAssessment,
  SecurityReport,
  SizingDecision,
  StrategySignal,
  Trade,
  TradeProposal,
  TradingMode,
} from './types';
import { newId } from './util/ids';

export interface EngineOptions {
  name: string;
  version: string;
  paperStartingEquity: string;
  /** LIVE_TRADING_ENABLED from the server environment. */
  liveTradingEnabled: boolean;
  scanEveryMs: number;
  exitCheckEveryMs: number;
  equitySnapshotEveryMs: number;
  maxPipelinePerTick: number;
  maxSnapshotsPerTick: number;
  maxActiveCandidates: number;
  snapshotPersistEveryMs: number;
  orderTimeoutMs: number;
  orderUnknownAfterMs: number;
  /** Consecutive failed exits after which a position is flagged unsellable. */
  unsellableAfterFailures: number;
}

export const DEFAULT_ENGINE_OPTIONS: EngineOptions = {
  name: 'Sniper Terminal',
  version: '0.1.0',
  paperStartingEquity: '1000',
  liveTradingEnabled: false,
  scanEveryMs: 3000,
  exitCheckEveryMs: 2000,
  equitySnapshotEveryMs: 15_000,
  maxPipelinePerTick: 40,
  maxSnapshotsPerTick: 30,
  maxActiveCandidates: 150,
  snapshotPersistEveryMs: 30_000,
  orderTimeoutMs: 45_000,
  orderUnknownAfterMs: 120_000,
  unsellableAfterFailures: 5,
};

export interface EngineDeps {
  store: Store;
  market: MarketDataProvider;
  quotes: QuoteProvider;
  security: SecurityProvider[];
  paperAdapter: ExecutionAdapter;
  liveAdapter: ExecutionAdapter | null;
  hardLimits: HardLimits;
  defaultConfig: EngineConfig;
  options?: Partial<EngineOptions>;
  /** Wall clock for liveness checks. Defaults to the engine's tick time (virtual time in backtests). */
  clock?: () => number;
}

export class EngineError extends Error {
  constructor(
    message: string,
    public readonly code: 'invalid' | 'forbidden' | 'not_found' | 'conflict' | 'unavailable',
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

type Listener = (e: EngineEvent) => void;
type Command = { run: (now: number) => Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void };

const BREAKERS: [string, string][] = [
  ['stale_data', 'Market data freshness'],
  ['provider_health', 'Provider health'],
  ['daily_loss', 'Daily loss limit'],
  ['drawdown', 'Max drawdown'],
  ['consecutive_losses', 'Consecutive losses'],
  ['execution_errors', 'Execution errors'],
  ['exit_quotes', 'Exit quote availability'],
];

const HISTORY_CAP = 120;

/**
 * Orchestrator / supervisor. A single-writer actor: all state mutation happens
 * inside `tick()` or inside queued commands executed at the start of a tick,
 * so agents never race on the same token, order, wallet or position.
 */
export class Engine {
  readonly opts: EngineOptions;
  private readonly store: Store;
  private readonly market: MarketDataProvider;
  private readonly quotes: QuoteProvider;
  private readonly security: SecurityProvider[];
  private readonly adapters: Record<TradingMode, ExecutionAdapter | null>;
  readonly hard: HardLimits;

  config: EngineConfig;
  configVersion = 1;
  mode: TradingMode = 'paper';
  liveAuthorized = false;
  killSwitch = false;
  entriesPaused = false;
  pauseReason: string | null = null;

  private ledgers: Record<TradingMode, Ledger | null> = { paper: null, live: null };
  private candidates = new Map<string, Candidate>();
  private poolIndex = new Map<string, string>();
  private tokenSeen = new Set<string>();
  private history = new Map<string, MarketSnapshot[]>();
  private reports = new Map<string, SecurityReport>();
  private assessments = new Map<string, RiskAssessment>();
  private proposals = new Map<string, TradeProposal>();
  private positions = new Map<string, Position>();
  private orders = new Map<string, Order>();
  private trades: Trade[] = [];
  private equity: Record<TradingMode, EquitySnapshot[]> = { paper: [], live: [] };
  private alerts: Alert[] = [];
  private breakers = new Map<string, CircuitBreakerState>();
  private providers = new Map<string, ProviderHealth>();
  private counters: PipelineCounters = {
    discovered: 0, screened: 0, rejected: 0, eligible: 0, proposed: 0, approved: 0, entered: 0, exited: 0, skipped: 0, expired: 0, txFailures: 0, txSubmitted: 0, avgSlippagePct: null,
  };
  private slippageSum = d(0);
  private slippageN = 0;
  private txStats: Record<TradingMode, { submitted: number; failed: number }> = { paper: { submitted: 0, failed: 0 }, live: { submitted: 0, failed: 0 } };
  private execErrors: number[] = [];
  private consecutiveLosses: Record<TradingMode, number> = { paper: 0, live: 0 };
  private lossCooldownUntil: Record<TradingMode, number | null> = { paper: null, live: null };
  private exitQuoteFailures = new Map<string, number>();
  private lastSnapshotPersist = new Map<string, number>();
  private lastSkipReason = new Map<string, string>();

  private batch: WriteBatch = {};
  private listeners = new Set<Listener>();
  private commands: Command[] = [];
  private ticking = false;
  private initialized = false;

  readonly agents: AgentRegistry;
  readonly log: AuditLogger;
  startedAt: number;
  now: number;
  lastTickAt: number | null = null;
  tickCount = 0;
  lastMarketDataAt: number | null = null;
  private lastDiscoveryAt = 0;
  private lastScanAt = 0;
  private lastExitCheckAt = 0;
  private lastEquityAt = 0;
  private lastEntryAt = 0;
  private lastPerfEmit = 0;
  private readonly wall: () => number;

  constructor(deps: EngineDeps, now: number = Date.now()) {
    this.opts = { ...DEFAULT_ENGINE_OPTIONS, ...deps.options };
    this.store = deps.store;
    this.market = deps.market;
    this.quotes = deps.quotes;
    this.security = deps.security;
    this.adapters = { paper: deps.paperAdapter, live: deps.liveAdapter };
    this.hard = deps.hardLimits;
    this.wall = deps.clock ?? (() => this.now);
    this.config = structuredClone(deps.defaultConfig);
    this.startedAt = now;
    this.now = now;
    this.lastDiscoveryAt = now - 60_000;
    this.agents = new AgentRegistry(now, (a) => this.emit({ type: 'agent', data: a }));
    this.log = new AuditLogger(0, () => ({ mode: this.mode, configVersion: this.configVersion, now: this.now }), (e) => this.emit({ type: 'audit', data: e }));
    for (const [id, label] of BREAKERS) this.breakers.set(id, { id, label, tripped: false, reason: null, since: null, until: null });
  }

  // ════════════════════════ lifecycle ════════════════════════

  async init(now: number = Date.now()): Promise<void> {
    this.now = now;
    await this.store.init();
    const st = await this.store.load();
    if (st.config) {
      const parsed = EngineConfigSchema.safeParse(st.config.config);
      if (parsed.success && checkHardLimits(parsed.data, this.hard).length === 0) {
        this.config = parsed.data;
        this.configVersion = st.config.version;
      } else {
        this.raise('warning', 'config_invalid', 'Stored config rejected', 'persisted configuration failed validation or hard limits; defaults loaded');
      }
    } else {
      this.put({ configs: [{ version: 1, config: this.config, changedBy: 'system', changedAt: now, note: 'initial defaults' }] });
    }
    this.log.resetSeq(st.lastAuditSeq);
    this.log.seed(st.recentAudit);
    for (const l of st.ledgers) this.ledgers[l.mode] = l;
    if (!this.ledgers.paper) {
      this.ledgers.paper = newLedger('paper', this.opts.paperStartingEquity, now);
      this.put({ ledgers: [this.ledgers.paper] });
    }
    for (const p of [...st.openPositions, ...st.recentPositions]) this.positions.set(p.id, p);
    this.trades = st.recentTrades.sort((a, b) => a.exitAt - b.exitAt);
    for (const e of st.equity) this.equity[e.mode].push(e);
    this.alerts = st.recentAlerts.sort((a, b) => a.ts - b.ts);
    this.txStats.paper.submitted = st.counters.txSubmitted;
    this.txStats.paper.failed = st.counters.txFailed;
    // Pipeline counters are per process, except transaction totals which come from the store.
    this.counters.txSubmitted = st.counters.txSubmitted;
    this.counters.txFailures = st.counters.txFailed;
    for (const m of ['paper', 'live'] as const) this.recomputeLossStreak(m);

    // Candidates that were mid-pipeline are stale after a restart.
    for (const c of st.activeCandidates) {
      if (['OPEN', 'EXIT_PENDING', 'RECONCILIATION_REQUIRED', 'EXECUTION_PENDING'].includes(c.stage)) {
        this.candidates.set(c.id, c);
        this.poolIndex.set(c.pool.address, c.id);
        this.tokenSeen.add(c.pool.token.address);
      } else {
        // Evaluation state (quotes, proposals) is stale after a restart.
        expireOnRestart(c, now);
        this.put({ candidates: [c] });
      }
    }
    // Orders that were in flight need reconciliation.
    for (const o of st.pendingOrders) {
      this.orders.set(o.id, o);
      if (o.status === 'created') {
        o.status = 'unknown';
        o.statusReason = 'process stopped before submission was confirmed';
      }
    }
    // Live trading is never resumed automatically.
    this.mode = 'paper';
    this.liveAuthorized = false;
    this.initialized = true;
    this.audit({ agent: 'orchestrator', action: 'ENGINE_START', result: 'info', reason: `engine started in PAPER mode · ${this.positions.size} positions restored · ${st.pendingOrders.length} orders to reconcile`, metrics: { persistent: this.store.persistent, market: this.market.name, simulated: this.market.simulated } });
    for (const id of ['scanner', 'risk', 'strategy', 'sizer', 'executor', 'exit', 'equity', 'logger', 'orchestrator'] as const) this.agents.setState(id, now, 'ok');
    await this.flush();
  }

  onEvent(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: EngineEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        /* listener errors must never affect trading */
      }
    }
  }

  /** Queue a command; it runs at the start of the next tick (single writer). */
  command<T>(run: (now: number) => Promise<T>): Promise<T> {
    if (!this.initialized) return Promise.reject(new EngineError('engine not initialized', 'unavailable'));
    return new Promise<T>((resolve, reject) => this.commands.push({ run, resolve: resolve as (v: unknown) => void, reject }));
  }

  async tick(now: number = Date.now()): Promise<void> {
    if (this.ticking || !this.initialized) return;
    this.ticking = true;
    this.now = now;
    try {
      await this.runCommands(now);
      await this.pollMarket(now);
      if (now - this.lastScanAt >= this.opts.scanEveryMs) {
        this.lastScanAt = now;
        await this.discover(now);
      }
      await this.refreshCandidates(now);
      await this.processPipeline(now);
      await this.pollOrders(now);
      if (now - this.lastExitCheckAt >= this.opts.exitCheckEveryMs) {
        this.lastExitCheckAt = now;
        await this.manageExits(now);
      }
      this.updateBreakers(now);
      if (now - this.lastEquityAt >= this.opts.equitySnapshotEveryMs) {
        this.lastEquityAt = now;
        this.snapshotEquity(now);
      }
      this.gc(now);
      this.lastTickAt = now;
      this.tickCount++;
      this.agents.update('orchestrator', now, { state: this.entryBlockReason() ? 'blocked' : 'ok', currentTask: `tick #${this.tickCount}`, warning: this.entryBlockReason() });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.agents.error('orchestrator', now, msg);
      this.audit({ agent: 'orchestrator', action: 'TICK_ERROR', result: 'error', reason: msg });
      this.raise('critical', 'agent_failure', 'Orchestrator error', msg);
    } finally {
      try {
        await this.flush();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.agents.error('logger', now, `persistence failed: ${msg}`);
        this.pauseEntries(`persistence failure: ${msg}`);
      }
      this.ticking = false;
      if (now - this.lastPerfEmit > 1000) {
        this.lastPerfEmit = now;
        this.emit({ type: 'status', data: this.status() });
        this.emit({ type: 'counters', data: this.countersView() });
        this.emit({ type: 'performance', data: this.performance() });
      }
    }
  }

  private async runCommands(now: number): Promise<void> {
    const cmds = this.commands.splice(0);
    for (const c of cmds) {
      try {
        c.resolve(await c.run(now));
      } catch (e) {
        c.reject(e);
      }
      await this.flush();
    }
  }

  // ════════════════════════ persistence helpers ════════════════════════

  private put(b: WriteBatch): void {
    for (const [k, v] of Object.entries(b) as [keyof WriteBatch, unknown[]][]) {
      if (!v?.length) continue;
      const cur = (this.batch[k] ?? []) as unknown[];
      cur.push(...v);
      (this.batch as Record<string, unknown[]>)[k] = cur;
    }
  }

  async flush(): Promise<void> {
    const audit = this.log.drain();
    if (audit.length) this.put({ audit });
    const b = this.batch;
    this.batch = {};
    if (Object.keys(b).length === 0) return;
    // De-duplicate upserts so only the latest version of each record is written.
    for (const k of ['candidates', 'orders', 'positions', 'proposals', 'alerts', 'transactions'] as const) {
      const xs = b[k] as { id: string }[] | undefined;
      if (xs) (b as Record<string, unknown>)[k] = [...new Map(xs.map((x) => [x.id, structuredClone(x)])).values()];
    }
    if (b.ledgers) b.ledgers = [...new Map(b.ledgers.map((l) => [l.mode, { ...l }])).values()];
    await this.store.write(b);
  }

  private audit(i: AuditInput): void {
    this.log.log(i);
  }

  private raise(level: AlertLevel, kind: string, title: string, message: string, correlationId: string | null = null): Alert {
    const a: Alert = { id: newId('al', this.now), ts: this.now, level, kind, title, message, mode: this.mode, acknowledged: false, correlationId };
    this.alerts.push(a);
    if (this.alerts.length > 200) this.alerts.splice(0, this.alerts.length - 200);
    this.put({ alerts: [a] });
    this.emit({ type: 'alert', data: a });
    return a;
  }

  private health(provider: string, kind: ProviderHealth['kind'], ok: boolean, err: string | null, latencyMs: number | null): void {
    const h = this.providers.get(provider) ?? { provider, kind, ok: true, lastSuccessAt: null, lastErrorAt: null, lastError: null, consecutiveFailures: 0, latencyMs: null };
    if (ok) {
      h.ok = true;
      h.lastSuccessAt = this.now;
      h.consecutiveFailures = 0;
      h.latencyMs = latencyMs;
    } else {
      h.consecutiveFailures++;
      h.ok = h.consecutiveFailures < 3;
      h.lastErrorAt = this.now;
      h.lastError = err;
    }
    this.providers.set(provider, h);
  }

  private async call<T>(provider: string, kind: ProviderHealth['kind'], fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
    const t0 = Date.now();
    try {
      const value = await fn();
      this.health(provider, kind, true, null, Date.now() - t0);
      return { ok: true, value };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // A non-transient error about one pool is not a provider outage.
      if (!(e instanceof ProviderError && !e.transient)) this.health(provider, kind, false, msg, null);
      return { ok: false, error: msg };
    }
  }

  // ════════════════════════ scanner ════════════════════════

  private async pollMarket(now: number): Promise<void> {
    if (!this.market.poll) return;
    const r = await this.call(this.market.name, 'market', () => this.market.poll!(now));
    if (!r.ok) this.agents.error('scanner', now, r.error);
  }

  private activeCandidateCount(): number {
    let n = 0;
    for (const c of this.candidates.values()) if (!isTerminal(c.stage)) n++;
    return n;
  }

  private async discover(now: number): Promise<void> {
    this.agents.update('scanner', now, { state: 'working', currentTask: 'discovering new pools' });
    const r = await this.call(this.market.name, 'market', () => this.market.discoverPools(this.lastDiscoveryAt, now));
    if (!r.ok) {
      this.agents.error('scanner', now, `discovery failed: ${r.error}`);
      return;
    }
    this.lastMarketDataAt = now;
    let newest = this.lastDiscoveryAt;
    for (const pool of r.value) {
      newest = Math.max(newest, pool.createdAt);
      const key = pool.address;
      if (this.poolIndex.has(key) || this.tokenSeen.has(pool.token.address)) continue;
      if (this.activeCandidateCount() >= this.opts.maxActiveCandidates) {
        this.agents.count('scanner', 'dropped_capacity');
        continue;
      }
      this.addCandidate(pool, now);
    }
    this.lastDiscoveryAt = newest;
    this.agents.update('scanner', now, { state: 'ok', currentTask: `tracking ${this.activeCandidateCount()} candidates` });
  }

  private addCandidate(pool: PoolInfo, now: number): Candidate {
    const c: Candidate = {
      id: newId('cand', now),
      chain: pool.chain,
      pool,
      stage: 'DISCOVERED',
      stageReason: 'new pool detected',
      stageHistory: [{ stage: 'DISCOVERED', ts: now, reason: 'new pool detected' }],
      discoveredAt: now,
      updatedAt: now,
      expiresAt: now + this.config.trading.candidateTtlSec * 1000,
      scannerScore: 0,
      snapshot: null,
      riskVerdict: null,
      riskScore: null,
      riskAssessmentId: null,
      signalScore: null,
      strategy: null,
      proposalId: null,
      positionId: null,
      lastEvaluatedAt: null,
      evaluations: 0,
      nextEvalAt: now,
    };
    this.candidates.set(c.id, c);
    this.poolIndex.set(pool.address, c.id);
    this.tokenSeen.add(pool.token.address);
    this.counters.discovered++;
    this.agents.count('scanner', 'discovered');
    this.put({ pools: [pool], candidates: [c] });
    this.audit({ agent: 'scanner', action: 'DISCOVERED', result: 'info', correlationId: c.id, tokenAddress: pool.token.address, symbol: pool.token.symbol, reason: `new ${pool.dex} pool ${short(pool.address)} · ${pool.token.symbol}/${pool.quoteSymbol}`, metrics: { ageSec: Math.round((now - pool.createdAt) / 1000), source: pool.source } });
    this.agents.update('scanner', now, { lastAction: `discovered $${pool.token.symbol}` });
    this.emitCandidate(c);
    return c;
  }

  private emitCandidate(c: Candidate): void {
    this.emit({ type: 'candidate', data: c });
  }

  private async snapshot(pool: PoolInfo, now: number): Promise<{ ok: true; value: MarketSnapshot } | { ok: false; error: string }> {
    const r = await this.call(this.market.name, 'market', () => this.market.getSnapshot(pool, now));
    if (!r.ok) return r;
    const snap = r.value;
    // Treat provider data as untrusted.
    const bad = [snap.price, snap.liquidity, snap.volume.m5, snap.volume.h1].some((x) => !/^\d+(\.\d+)?$/.test(x)) || d(snap.price).lte(0) || snap.poolAddress !== pool.address || snap.tokenAddress !== pool.token.address || snap.ts > now + 5000;
    if (bad) return { ok: false, error: 'provider returned malformed or mismatched snapshot' };
    this.lastMarketDataAt = now;
    const h = this.history.get(pool.address) ?? [];
    h.push(snap);
    if (h.length > HISTORY_CAP) h.splice(0, h.length - HISTORY_CAP);
    this.history.set(pool.address, h);
    const last = this.lastSnapshotPersist.get(pool.address) ?? 0;
    if (now - last >= this.opts.snapshotPersistEveryMs) {
      this.lastSnapshotPersist.set(pool.address, now);
      this.put({ snapshots: [snap] });
    }
    return r;
  }

  private async refreshCandidates(now: number): Promise<void> {
    const due = [...this.candidates.values()]
      .filter((c) => (c.stage === 'DISCOVERED' || c.stage === 'ELIGIBLE') && c.nextEvalAt <= now)
      .sort((a, b) => a.nextEvalAt - b.nextEvalAt)
      .slice(0, this.opts.maxSnapshotsPerTick);
    for (const c of due) {
      if (now >= c.expiresAt) {
        this.move(c, 'EXPIRED', `no qualifying signal within ${Math.round(this.config.trading.candidateTtlSec / 60)}m`);
        this.counters.expired++;
        continue;
      }
      const r = await this.snapshot(c.pool, now);
      if (!r.ok) {
        c.nextEvalAt = now + 5000;
        this.agents.update('scanner', now, { warning: `snapshot failed: ${r.error}` });
        continue;
      }
      c.snapshot = r.value;
      c.scannerScore = scannerScore(r.value, this.config.trading, now, c.pool.createdAt).score;
      c.updatedAt = now;
    }
  }

  // ════════════════════════ pipeline ════════════════════════

  private move(c: Candidate, to: PipelineStage, reason: string | null): void {
    transition(c, to, reason, this.now);
    this.put({ candidates: [c] });
    this.emitCandidate(c);
  }

  private async processPipeline(now: number): Promise<void> {
    let budget = this.opts.maxPipelinePerTick;
    for (const c of [...this.candidates.values()]) {
      if (budget <= 0) break;
      try {
        if (c.stage === 'DISCOVERED' && c.snapshot && c.nextEvalAt <= now) {
          budget--;
          await this.screen(c, now);
        } else if (c.stage === 'ELIGIBLE' && c.snapshot && c.nextEvalAt <= now && c.lastEvaluatedAt !== c.snapshot.fetchedAt) {
          budget--;
          await this.evaluateSignal(c, now);
        } else if (c.stage === 'TRADE_PROPOSED' && c.proposalId) {
          const p = this.proposals.get(c.proposalId);
          if (p && now > p.expiresAt) this.expireProposal(c, p, 'proposal expired before execution');
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.agents.error('orchestrator', now, `${c.pool.token.symbol}: ${msg}`);
        this.audit({ agent: 'orchestrator', action: 'PIPELINE_ERROR', result: 'error', correlationId: c.id, symbol: c.pool.token.symbol, tokenAddress: c.pool.token.address, reason: msg });
        if (!isTerminal(c.stage) && ['DISCOVERED', 'SCREENING', 'ELIGIBLE', 'SIGNAL_EVALUATION', 'TRADE_PROPOSED', 'RISK_APPROVED'].includes(c.stage)) {
          // Fail safe: never continue a candidate with incomplete critical information.
          if (c.stage === 'SCREENING') this.move(c, 'FAILED', `agent failure: ${msg}`);
          else if (c.stage === 'SIGNAL_EVALUATION') this.move(c, 'REJECTED', `agent failure: ${msg}`);
          else if (c.stage === 'DISCOVERED' || c.stage === 'ELIGIBLE') this.move(c, 'EXPIRED', `agent failure: ${msg}`);
          else this.move(c, 'CANCELLED', `agent failure: ${msg}`);
        }
      }
    }
  }

  /** Scanner quality gate + Risk Guard screening. */
  private async screen(c: Candidate, now: number): Promise<void> {
    const t = this.config.trading;
    const snap = c.snapshot!;
    const ageSec = (now - c.pool.createdAt) / 1000;
    if (ageSec < t.minPoolAgeSec) {
      c.nextEvalAt = c.pool.createdAt + t.minPoolAgeSec * 1000;
      return;
    }
    const sc = scannerScore(snap, t, now, c.pool.createdAt);
    c.scannerScore = sc.score;
    if (ageSec > t.maxPoolAgeSec || d(snap.liquidity).lt(d(t.minLiquidity).times(0.5))) {
      this.move(c, 'SCREENING', 'scanner quality gate');
      this.move(c, 'REJECTED', `scanner: ${sc.notes.join(', ') || 'below minimum market quality'}`);
      this.counters.rejected++;
      this.audit({ agent: 'scanner', action: 'FILTERED', result: 'reject', correlationId: c.id, symbol: c.pool.token.symbol, tokenAddress: c.pool.token.address, reason: c.stageReason ?? '', metrics: { score: sc.score, liquidity: snap.liquidity } });
      return;
    }
    if (sc.score < t.minScannerScore) {
      c.nextEvalAt = now + t.reevaluateEverySec * 1000;
      return;
    }
    this.audit({ agent: 'scanner', action: 'QUALIFIED', result: 'pass', correlationId: c.id, symbol: c.pool.token.symbol, tokenAddress: c.pool.token.address, reason: `scanner score ${sc.score} ≥ ${t.minScannerScore}`, metrics: { score: sc.score, liquidity: s(snap.liquidity, 2), vol5m: s(snap.volume.m5, 2), buys5m: snap.txns.m5.buys, sells5m: snap.txns.m5.sells } });
    this.move(c, 'SCREENING', 'risk screening');
    this.counters.screened++;
    this.agents.update('risk', now, { state: 'working', currentTask: `screening $${c.pool.token.symbol}` });

    const reports: SecurityReport[] = [];
    const errors: string[] = [];
    for (const sp of this.security) {
      const r = await this.call(sp.name, 'security', () => sp.assess(c.chain, c.pool.token.address, c.pool, now));
      if (r.ok) reports.push(r.value);
      else errors.push(r.error);
    }
    const report = reports.length ? mergeSecurityReports(reports, now) : null;
    if (report) this.reports.set(c.id, report);
    const res = evaluateRisk({ report, reportError: errors.join('; ') || null, snapshot: snap, trading: t, risk: this.config.risk, now });
    const a = this.recordAssessment(c, res, 'screening', now);
    this.agents.count('risk', res.verdict.toLowerCase());
    if (res.verdict === 'REJECT' || (res.verdict === 'REVIEW' && this.config.risk.reviewPolicy === 'reject')) {
      this.move(c, 'REJECTED', res.verdict === 'REJECT' ? res.summary : `${res.summary} (review policy: reject)`);
      this.counters.rejected++;
    } else {
      this.move(c, 'ELIGIBLE', res.summary);
      this.counters.eligible++;
      c.nextEvalAt = now;
    }
    this.audit({ agent: 'risk', action: 'RISK_CHECK', result: res.verdict === 'PASS' ? 'pass' : res.verdict === 'REVIEW' ? 'review' : 'reject', correlationId: c.id, symbol: c.pool.token.symbol, tokenAddress: c.pool.token.address, reason: res.summary, metrics: { riskScore: res.riskScore, confidence: res.confidence, factors: res.factors.map((f) => f.code).join(','), assessmentId: a.id } });
    this.agents.update('risk', now, { state: 'ok', currentTask: null, lastAction: `${res.verdict} $${c.pool.token.symbol}`, lastDecision: res.summary });
  }

  private recordAssessment(c: Candidate, res: ReturnType<typeof evaluateRisk>, phase: RiskAssessment['phase'], now: number): RiskAssessment {
    const a: RiskAssessment = {
      id: newId('ra', now),
      candidateId: c.id,
      chain: c.chain,
      tokenAddress: c.pool.token.address,
      poolAddress: c.pool.address,
      ts: now,
      ...res,
      configVersion: this.configVersion,
      phase,
    };
    this.assessments.set(c.id, a);
    c.riskVerdict = a.verdict;
    c.riskScore = a.riskScore;
    c.riskAssessmentId = a.id;
    this.put({ assessments: [a] });
    return a;
  }

  entryBlockReason(): string | null {
    if (this.killSwitch) return 'kill switch active';
    if (this.entriesPaused) return `entries paused${this.pauseReason ? `: ${this.pauseReason}` : ''}`;
    if (this.mode === 'live' && (!this.liveAuthorized || !this.adapters.live)) return 'live trading not authorized';
    for (const b of this.breakers.values()) if (b.tripped) return `circuit breaker: ${b.label} — ${b.reason}`;
    if (this.config.trading.enabledStrategies.length === 0) return 'no strategies enabled';
    return null;
  }

  private async evaluateSignal(c: Candidate, now: number): Promise<void> {
    const t = this.config.trading;
    const snap = c.snapshot!;
    c.lastEvaluatedAt = snap.fetchedAt;
    c.evaluations++;
    c.nextEvalAt = now + t.reevaluateEverySec * 1000;
    // Market-side risk is re-checked on every evaluation with fresh data.
    const report = this.reports.get(c.id) ?? null;
    const re = evaluateRisk({ report, snapshot: snap, trading: t, risk: this.config.risk, now });
    if (re.verdict === 'REJECT') {
      this.recordAssessment(c, re, 'screening', now);
      this.move(c, 'REJECTED', `re-screen: ${re.summary}`);
      this.counters.rejected++;
      this.audit({ agent: 'risk', action: 'RISK_RECHECK', result: 'reject', correlationId: c.id, symbol: c.pool.token.symbol, tokenAddress: c.pool.token.address, reason: re.summary, metrics: { riskScore: re.riskScore } });
      return;
    }
    const blocked = this.entryBlockReason();
    if (blocked) return;
    if (now - this.lastEntryAt < t.entryCooldownSec * 1000) return;

    this.move(c, 'SIGNAL_EVALUATION', null);
    this.agents.update('strategy', now, { state: 'working', currentTask: `evaluating $${c.pool.token.symbol}` });
    const hist = (this.history.get(c.pool.address) ?? []).filter((h) => h !== snap);
    const ctx = { pool: c.pool, snapshot: snap, history: hist, now, params: t.strategyParams, risk: { verdict: re.verdict, score: re.riskScore, confidence: re.confidence } };
    const minScore = re.verdict === 'REVIEW' ? Math.max(t.minSignalScore, this.config.risk.reviewMinSignalScore) : t.minSignalScore;
    let best: { id: (typeof t.enabledStrategies)[number]; res: Extract<ReturnType<(typeof STRATEGIES)['new_pool_entry']['evaluate']>, { kind: 'signal' }> } | null = null;
    const skips: string[] = [];
    for (const id of t.enabledStrategies) {
      const res = STRATEGIES[id].evaluate(ctx);
      if (res.kind === 'skip') skips.push(`${id}: ${res.reason}`);
      else if (res.score < minScore || res.confidence < t.minSignalConfidence) skips.push(`${id}: score ${res.score}/conf ${res.confidence} below threshold ${minScore}/${t.minSignalConfidence}`);
      else if (!best || res.score > best.res.score) best = { id, res };
    }
    if (!best) {
      this.move(c, 'ELIGIBLE', skips[0] ?? 'no signal');
      this.counters.skipped++;
      const reason = skips[0] ?? 'no signal';
      // Log a skip only when its reason changes (ignoring the numbers) to keep the log readable.
      const key = reason.replace(/[\d.]+/g, '#');
      if (this.lastSkipReason.get(c.id) !== key) {
        this.lastSkipReason.set(c.id, key);
        this.audit({ agent: 'strategy', action: 'NO_SIGNAL', result: 'skip', correlationId: c.id, symbol: c.pool.token.symbol, tokenAddress: c.pool.token.address, reason, metrics: { evaluations: c.evaluations } });
      }
      this.agents.update('strategy', now, { state: 'ok', currentTask: null, lastDecision: `skip $${c.pool.token.symbol}: ${reason}` });
      return;
    }
    const strat = STRATEGIES[best.id];
    const signal: StrategySignal = {
      id: newId('sig', now),
      candidateId: c.id,
      strategy: best.id,
      strategyVersion: strat.version,
      ts: now,
      dataTs: snap.ts,
      score: best.res.score,
      confidence: best.res.confidence,
      rationale: best.res.rationale,
      entryConditions: best.res.entryConditions,
      invalidation: best.res.invalidation,
      referencePrice: snap.price,
      // Mid price plus the tolerated slippage and price impact.
      maxEntryPrice: s(d(snap.price).times(d(1).plus(pct(min(t.maxSlippagePct, this.hard.maxSlippagePct).plus(min(t.maxPriceImpactPct, this.hard.maxPriceImpactPct))))), 18),
      exitPolicy: structuredClone(t.exitPolicy),
      metrics: best.res.metrics,
    };
    c.signalScore = signal.score;
    c.strategy = signal.strategy;
    this.put({ signals: [signal] });
    this.audit({ agent: 'strategy', action: 'SIGNAL', result: 'pass', correlationId: c.id, symbol: c.pool.token.symbol, tokenAddress: c.pool.token.address, reason: `${strat.label}: ${signal.rationale}`, strategyVersion: `${signal.strategy}@${signal.strategyVersion}`, metrics: { score: signal.score, confidence: signal.confidence, ...signal.metrics } });
    this.agents.update('strategy', now, { state: 'ok', currentTask: null, lastAction: `signal $${c.pool.token.symbol} (${signal.score})`, lastDecision: signal.rationale });
    await this.propose(c, signal, re.verdict, now);
  }

  portfolioState(mode: TradingMode, tokenAddress: string | null): PortfolioState {
    const l = this.ledger(mode);
    const open = [...this.positions.values()].filter((p) => p.mode === mode && ['open', 'exit_pending', 'reconciliation_required', 'pending'].includes(p.status));
    const v = valuePortfolio(l, open);
    let tokenExp = d(0);
    let newLaunch = d(0);
    for (const p of open) {
      if (p.tokenAddress === tokenAddress) tokenExp = tokenExp.plus(p.openCostBasis);
      newLaunch = newLaunch.plus(p.openCostBasis);
    }
    // Pending entry orders count as exposure too.
    for (const o of this.orders.values()) {
      if (o.mode === mode && o.purpose === 'entry' && (o.status === 'submitted' || o.status === 'created' || o.status === 'unknown')) {
        newLaunch = newLaunch.plus(o.amountIn);
        if (o.tokenAddress === tokenAddress) tokenExp = tokenExp.plus(o.amountIn);
      }
    }
    const pendingEntries = [...this.orders.values()].filter((o) => o.mode === mode && o.purpose === 'entry' && (o.status === 'submitted' || o.status === 'created'));
    return {
      equity: s(v.equity, 8),
      dayStartEquity: l.dayStartEquity,
      peakEquity: s(Decimal.max(d(l.peakEquity), v.equity), 8),
      cash: l.cash,
      reserved: l.reserved,
      openExposure: s(v.openCost.plus(pendingEntries.reduce((a, o) => a.plus(o.amountIn), d(0))), 8),
      tokenExposure: s(tokenExp, 8),
      newLaunchExposure: s(newLaunch, 8),
      openPositions: open.length + pendingEntries.length,
      consecutiveLosses: this.consecutiveLosses[mode],
      lossCooldownUntil: this.lossCooldownUntil[mode],
    };
  }

  private async quote(req: Parameters<QuoteProvider['getQuote']>[0], now: number) {
    const r = await this.call(this.quotes.name, 'market', () => this.quotes.getQuote(req, now));
    if (r.ok) {
      const q = r.value;
      const sane = q.side === req.side && d(q.amountIn).eq(req.amountIn) && /^\d+(\.\d+)?$/.test(q.expectedOut) && d(q.expectedOut).gt(0) && d(q.priceImpactPct).gte(-1);
      if (!sane) return { ok: false as const, error: 'quote failed validation' };
    }
    return r;
  }

  private size(c: Candidate, signal: StrategySignal, verdict: RiskAssessment['verdict'], estEntryCostPct: string, estExitCostPct: string, now: number): SizingResult {
    return sizePosition({
      portfolio: this.portfolioState(this.mode, c.pool.token.address),
      trading: this.config.trading,
      risk: this.config.risk,
      hard: this.hard,
      liquidity: c.snapshot!.liquidity,
      stopLossPct: signal.exitPolicy.stopLossPct,
      estEntryCostPct,
      estExitCostPct,
      riskVerdict: verdict,
      isNewLaunch: (now - c.pool.createdAt) / 1000 < 24 * 3600,
      now,
    });
  }

  /** Sizer + pre-execution risk check → proposal. */
  private async propose(c: Candidate, signal: StrategySignal, verdict: RiskAssessment['verdict'], now: number): Promise<void> {
    const t = this.config.trading;
    this.agents.update('sizer', now, { state: 'working', currentTask: `sizing $${c.pool.token.symbol}` });
    // Probe quote at the nominal allocation to estimate costs.
    const pf = this.portfolioState(this.mode, c.pool.token.address);
    const nominal = max(1, d(pf.equity).times(pct(t.maxTradeAllocationPct))).toDecimalPlaces(2);
    const probe = await this.quote({ chain: c.chain, poolAddress: c.pool.address, tokenAddress: c.pool.token.address, side: 'buy', amountIn: s(nominal, 2) }, now);
    if (!probe.ok) {
      this.move(c, 'ELIGIBLE', `quote unavailable: ${probe.error}`);
      this.agents.update('sizer', now, { state: 'warning', currentTask: null, warning: probe.error });
      return;
    }
    const entryCostPct = costPct(probe.value, nominal);
    const exitCostPct = entryCostPct; // symmetric estimate for an AMM round trip
    let sizing = this.size(c, signal, verdict, entryCostPct, exitCostPct, now);
    let sizingRec = this.recordSizing(c, sizing, now);
    this.move(c, 'TRADE_PROPOSED', `${signal.strategy} score ${signal.score}`);
    this.counters.proposed++;
    if (!sizing.approved) {
      this.audit({ agent: 'sizer', action: 'SIZE', result: sizing.deferred ? 'skip' : 'reject', correlationId: c.id, symbol: c.pool.token.symbol, tokenAddress: c.pool.token.address, reason: sizing.reasons.join('; '), metrics: sizingMetrics(sizing) });
      if (sizing.deferred) {
        this.move(c, 'ELIGIBLE', `deferred: ${sizing.reasons.join('; ')}`);
        c.nextEvalAt = now + Math.max(t.reevaluateEverySec, 30) * 1000;
      } else {
        this.move(c, 'REJECTED', `sizer: ${sizing.reasons.join('; ')}`);
        this.counters.rejected++;
      }
      this.agents.update('sizer', now, { state: 'ok', currentTask: null, lastDecision: `${sizing.deferred ? 'defer' : 'reject'} $${c.pool.token.symbol}: ${sizing.reasons[0]}` });
      return;
    }
    // Quote the actual size; shrink if price impact exceeds the cap.
    const maxImpact = min(t.maxPriceImpactPct, this.hard.maxPriceImpactPct);
    let size = d(sizing.size);
    let q: Quote | null = null;
    for (let i = 0; i < 3; i++) {
      const r = await this.quote({ chain: c.chain, poolAddress: c.pool.address, tokenAddress: c.pool.token.address, side: 'buy', amountIn: s(size, 2) }, now);
      if (!r.ok) break;
      q = r.value;
      const impact = d(q.priceImpactPct);
      if (impact.lte(maxImpact)) break;
      size = size.times(maxImpact.div(impact)).times(0.9).toDecimalPlaces(2, Decimal.ROUND_DOWN);
      q = null;
      if (size.lt(this.config.risk.minTradeSizeQuote)) break;
    }
    if (!q) {
      this.move(c, 'REJECTED', `insufficient executable liquidity for minimum size (impact > ${maxImpact.toFixed(2)}%)`);
      this.counters.rejected++;
      this.audit({ agent: 'sizer', action: 'SIZE', result: 'reject', correlationId: c.id, symbol: c.pool.token.symbol, tokenAddress: c.pool.token.address, reason: c.stageReason ?? '', metrics: sizingMetrics(sizing) });
      return;
    }
    if (!size.eq(sizing.size)) {
      sizing = { ...sizing, size: s(size, 2), constraints: [...sizing.constraints.map((x) => ({ ...x, binding: false })), { name: 'priceImpactCap', limit: s(size, 2), binding: true }] };
      sizingRec = this.recordSizing(c, sizing, now);
    }
    this.audit({ agent: 'sizer', action: 'SIZE', result: 'pass', correlationId: c.id, symbol: c.pool.token.symbol, tokenAddress: c.pool.token.address, sizeQuote: sizing.size, reason: `size ${sizing.size} (max ${sizing.maxAllowed}, bound by ${sizing.constraints.find((x) => x.binding)?.name ?? 'n/a'})`, metrics: sizingMetrics(sizing) });
    this.agents.update('sizer', now, { state: 'ok', currentTask: null, lastAction: `sized $${c.pool.token.symbol} ${sizing.size}`, lastDecision: `${s(d(sizing.size).div(sizing.equity).times(100), 2)}% of equity` });

    // Pre-execution risk recheck with executable quotes (entry and exit side).
    const exitQ = await this.quote({ chain: c.chain, poolAddress: c.pool.address, tokenAddress: c.pool.token.address, side: 'sell', amountIn: q.expectedOut }, now);
    const report = this.reports.get(c.id) ?? null;
    const pre = evaluateRisk({ report, snapshot: c.snapshot!, quote: q, exitQuote: exitQ.ok ? exitQ.value : null, trading: t, risk: this.config.risk, now });
    if (!exitQ.ok) pre.factors.push({ code: 'EXIT_QUOTE_UNAVAILABLE', severity: 'critical', message: `cannot obtain exit quote: ${exitQ.error}`, value: null, source: this.quotes.name, observedAt: now, blocking: true });
    if (!exitQ.ok) {
      pre.verdict = 'REJECT';
      pre.summary = 'REJECT — no executable exit quote';
    }
    const preA = this.recordAssessment(c, pre, 'pre_execution', now);
    this.audit({ agent: 'risk', action: 'PRE_EXEC_CHECK', result: pre.verdict === 'REJECT' ? 'reject' : pre.verdict === 'REVIEW' ? 'review' : 'pass', correlationId: c.id, symbol: c.pool.token.symbol, tokenAddress: c.pool.token.address, reason: pre.summary, metrics: { riskScore: pre.riskScore, impact: q.priceImpactPct, exitImpact: exitQ.ok ? exitQ.value.priceImpactPct : null } });
    if (pre.verdict === 'REJECT' || (pre.verdict === 'REVIEW' && this.config.risk.reviewPolicy === 'reject')) {
      this.move(c, 'REJECTED', `pre-execution: ${pre.summary}`);
      this.counters.rejected++;
      return;
    }

    const roundTrip = d(entryCostPct).plus(exitCostPct);
    const proposal: TradeProposal = {
      id: newId('prop', now),
      candidateId: c.id,
      mode: this.mode,
      chain: c.chain,
      tokenAddress: c.pool.token.address,
      poolAddress: c.pool.address,
      symbol: c.pool.token.symbol,
      strategy: signal.strategy,
      strategyVersion: signal.strategyVersion,
      signalId: signal.id,
      signalScore: signal.score,
      signalConfidence: signal.confidence,
      rationale: signal.rationale,
      entryConditions: signal.entryConditions,
      invalidation: signal.invalidation,
      size: sizing.size,
      maxEntryPrice: signal.maxEntryPrice,
      exitPolicy: signal.exitPolicy,
      maxHoldSec: signal.exitPolicy.maxHoldSec,
      estFeesQuote: s(d(q.swapFeeQuote).plus(q.networkFeeQuote).times(2), 8),
      estSlippagePct: s(roundTrip, 4),
      estPriceImpactPct: q.priceImpactPct,
      dataTs: signal.dataTs,
      createdAt: now,
      expiresAt: now + t.proposalTtlSec * 1000,
      status: 'proposed',
      statusReason: null,
      riskVerdict: preA.verdict,
      riskScore: preA.riskScore,
      sizingDecisionId: sizingRec.id,
    };
    this.proposals.set(proposal.id, proposal);
    c.proposalId = proposal.id;
    const needsManual = (preA.verdict === 'REVIEW' && this.config.risk.reviewPolicy === 'manual') || (this.mode === 'live' && this.config.risk.requireManualApprovalLive);
    if (needsManual) {
      proposal.status = 'awaiting_approval';
      proposal.statusReason = preA.verdict === 'REVIEW' ? 'REVIEW verdict requires manual approval' : 'live trades require manual approval';
      proposal.expiresAt = now + Math.max(t.proposalTtlSec, 60) * 1000;
      this.put({ proposals: [proposal] });
      this.emit({ type: 'approval', data: proposal });
      this.raise('info', 'approval_required', `Approval needed: $${proposal.symbol}`, `${proposal.strategy} · size ${proposal.size} · ${proposal.statusReason}`, c.id);
      this.audit({ agent: 'orchestrator', action: 'AWAIT_APPROVAL', result: 'info', correlationId: c.id, symbol: proposal.symbol, tokenAddress: proposal.tokenAddress, sizeQuote: proposal.size, reason: proposal.statusReason ?? '' });
      return;
    }
    await this.approveAndExecute(c, proposal, null, now);
  }

  private recordSizing(c: Candidate, r: SizingResult, now: number): SizingDecision {
    const rec: SizingDecision = { id: newId('sz', now), candidateId: c.id, ts: now, configVersion: this.configVersion, ...r };
    this.put({ sizing: [rec] });
    return rec;
  }

  private expireProposal(c: Candidate, p: TradeProposal, reason: string): void {
    p.status = 'expired';
    p.statusReason = reason;
    this.put({ proposals: [p] });
    this.move(c, 'EXPIRED', reason);
    this.counters.expired++;
    this.audit({ agent: 'orchestrator', action: 'PROPOSAL_EXPIRED', result: 'skip', correlationId: c.id, symbol: p.symbol, tokenAddress: p.tokenAddress, reason });
  }

  private async approveAndExecute(c: Candidate, p: TradeProposal, approvedBy: string | null, now: number): Promise<void> {
    p.status = 'approved';
    p.statusReason = approvedBy ? `approved by ${approvedBy}` : 'auto-approved within policy';
    this.put({ proposals: [p] });
    this.move(c, 'RISK_APPROVED', p.statusReason);
    this.counters.approved++;
    await this.executeEntry(c, p, approvedBy, now);
  }

  // ════════════════════════ executor ════════════════════════

  private async executeEntry(c: Candidate, p: TradeProposal, approvedBy: string | null, now: number): Promise<void> {
    const adapter = this.adapters[p.mode];
    const idem = `entry:${p.id}`;
    this.agents.update('executor', now, { state: 'working', currentTask: `pre-trade checks $${p.symbol}` });
    // Fresh market data and quote immediately before submission.
    const snapR = await this.snapshot(c.pool, now);
    if (snapR.ok) c.snapshot = snapR.value;
    const qR = await this.quote({ chain: p.chain, poolAddress: p.poolAddress, tokenAddress: p.tokenAddress, side: 'buy', amountIn: p.size }, now);
    const signalStop = p.exitPolicy.stopLossPct;
    const ec = qR.ok ? costPct(qR.value, d(p.size)) : '0';
    const sizingNow = sizePosition({
      portfolio: this.portfolioState(p.mode, p.tokenAddress),
      trading: this.config.trading,
      risk: this.config.risk,
      hard: this.hard,
      liquidity: c.snapshot?.liquidity ?? '0',
      stopLossPct: signalStop,
      estEntryCostPct: ec,
      estExitCostPct: ec,
      riskVerdict: p.riskVerdict,
      isNewLaunch: (now - c.pool.createdAt) / 1000 < 24 * 3600,
      now,
    });
    const conflicting =
      [...this.positions.values()].filter((x) => x.tokenAddress === p.tokenAddress && !['closed', 'failed'].includes(x.status)).length +
      [...this.orders.values()].filter((o) => o.tokenAddress === p.tokenAddress && ['created', 'submitted', 'unknown'].includes(o.status)).length;
    const outcome = entryPreTradeChecks({
      proposal: p,
      candidate: c,
      mode: this.mode,
      liveAuthorized: this.liveAuthorized,
      hasAdapter: !!adapter,
      killSwitch: this.killSwitch,
      entriesBlockedReason: this.entryBlockReason(),
      snapshot: snapR.ok ? snapR.value : null,
      assessment: this.assessments.get(c.id) ?? null,
      quote: qR.ok ? qR.value : null,
      quoteError: qR.ok ? null : qR.error,
      sizingNow,
      ledger: this.ledger(p.mode),
      trading: this.config.trading,
      risk: this.config.risk,
      hard: this.hard,
      conflictingExposure: conflicting,
      idempotencyKeyUsed: [...this.orders.values()].some((o) => o.idempotencyKey === idem),
      manualApprovalRequired: p.mode === 'live' && this.config.risk.requireManualApprovalLive,
      approvedBy,
      now,
    });
    const failed = outcome.checks.filter((x) => !x.ok);
    if (!outcome.ok || !adapter || !qR.ok) {
      const reason = failed.map((f) => `${f.name}: ${f.detail}`).join('; ') || 'no execution adapter';
      p.status = 'rejected';
      p.statusReason = reason;
      this.put({ proposals: [p] });
      this.audit({ agent: 'executor', action: 'ENTRY_BLOCKED', result: 'blocked', correlationId: c.id, symbol: p.symbol, tokenAddress: p.tokenAddress, sizeQuote: p.size, reason, metrics: Object.fromEntries(outcome.checks.map((x) => [x.name, x.ok])) });
      if (outcome.retryable) {
        this.move(c, 'ELIGIBLE', `deferred by executor: ${failed[0]?.name ?? 'adapter'}`);
        c.nextEvalAt = now + this.config.trading.reevaluateEverySec * 1000;
      } else {
        this.move(c, 'REJECTED', `executor: ${reason}`);
        this.counters.rejected++;
      }
      this.agents.update('executor', now, { state: 'ok', currentTask: null, lastDecision: `blocked $${p.symbol}: ${failed[0]?.name ?? 'adapter'}` });
      return;
    }
    const q = qR.value;
    const swap = { idempotencyKey: idem, chain: p.chain, poolAddress: p.poolAddress, tokenAddress: p.tokenAddress, side: 'buy' as const, amountIn: p.size, minOut: outcome.minOut!, priorityFeeQuote: this.config.trading.priorityFeeQuote };
    const sim = await this.call(adapter.name, 'execution', () => adapter.simulate(swap, now));
    if (!sim.ok || !sim.value.ok) {
      const reason = sim.ok ? sim.value.error ?? 'simulation failed' : sim.error;
      p.status = 'rejected';
      p.statusReason = `simulation: ${reason}`;
      this.put({ proposals: [p] });
      this.move(c, 'ELIGIBLE', `deferred: transaction simulation failed (${reason})`);
      c.nextEvalAt = now + this.config.trading.reevaluateEverySec * 1000;
      this.audit({ agent: 'executor', action: 'SIMULATION_FAILED', result: 'blocked', correlationId: c.id, symbol: p.symbol, tokenAddress: p.tokenAddress, sizeQuote: p.size, reason });
      return;
    }
    const order: Order = {
      id: newId('ord', now),
      idempotencyKey: idem,
      mode: p.mode,
      chain: p.chain,
      purpose: 'entry',
      side: 'buy',
      candidateId: c.id,
      positionId: null,
      proposalId: p.id,
      tokenAddress: p.tokenAddress,
      poolAddress: p.poolAddress,
      symbol: p.symbol,
      amountIn: p.size,
      minOut: outcome.minOut!,
      quotedOut: q.expectedOut,
      maxSlippagePct: s(min(this.config.trading.maxSlippagePct, this.hard.maxSlippagePct), 4),
      priorityFeeQuote: this.config.trading.priorityFeeQuote,
      reservedQuote: '0',
      estSwapFeeQuote: q.swapFeeQuote,
      status: 'created',
      statusReason: null,
      txId: null,
      filledIn: null,
      filledOut: null,
      fillPrice: null,
      networkFeeQuote: null,
      slippagePct: null,
      reason: `${p.strategy}: ${p.rationale}`,
      createdAt: now,
      submittedAt: null,
      settledAt: null,
      attempts: 0,
    };
    order.reservedQuote = s(d(p.size).plus(q.networkFeeQuote).plus(this.config.trading.priorityFeeQuote), 8);
    // Persist the order and reservation *before* submitting so a crash cannot lose it.
    this.ledgers[p.mode] = reserve(this.ledger(p.mode), order.reservedQuote, now);
    this.orders.set(order.id, order);
    this.move(c, 'EXECUTION_PENDING', `order ${order.id}`);
    this.put({ orders: [order], ledgers: [this.ledger(p.mode)] });
    await this.flush();
    order.attempts++;
    const sub = await this.call(adapter.name, 'execution', () => adapter.submit(swap, now));
    if (!sub.ok) {
      // Submission outcome uncertain — reconcile, never blindly retry.
      order.status = 'unknown';
      order.statusReason = `submit error: ${sub.error}`;
      order.submittedAt = now;
      this.put({ orders: [order] });
      this.audit({ agent: 'executor', action: 'SUBMIT_UNCERTAIN', result: 'warn', correlationId: c.id, symbol: p.symbol, tokenAddress: p.tokenAddress, sizeQuote: p.size, reason: order.statusReason });
      this.recordExecError(now);
      return;
    }
    order.status = 'submitted';
    order.txId = sub.value.txId;
    order.submittedAt = sub.value.submittedAt;
    p.status = 'executed';
    const tx: ChainTransaction = { id: newId('tx', now), orderId: order.id, mode: p.mode, chain: p.chain, signature: sub.value.txId, status: 'pending', error: null, networkFeeQuote: null, submittedAt: now, confirmedAt: null, simulated: p.mode === 'paper', explorerUrl: adapter.explorerUrl?.(sub.value.txId) ?? null };
    this.txIndex.set(order.id, tx);
    this.txStats[p.mode].submitted++;
    this.counters.txSubmitted++;
    this.lastEntryAt = now;
    this.put({ orders: [order], proposals: [p], transactions: [tx] });
    this.emit({ type: 'order', data: order });
    this.audit({ agent: 'executor', action: 'ORDER_SUBMITTED', result: 'enter', correlationId: c.id, symbol: p.symbol, tokenAddress: p.tokenAddress, sizeQuote: p.size, reason: `BUY ${p.size} → min ${d(order.minOut).toSignificantDigits(6).toString()} ${p.symbol} · impact ${d(q.priceImpactPct).toFixed(2)}% · slip cap ${order.maxSlippagePct}%`, metrics: { orderId: order.id, txId: order.txId, quotedOut: q.expectedOut, checks: outcome.checks.length, simulated: p.mode === 'paper' } });
    this.agents.update('executor', now, { state: 'ok', currentTask: `awaiting confirmation $${p.symbol}`, lastAction: `BUY $${p.symbol} ${p.size}` });
  }

  private txIndex = new Map<string, ChainTransaction>();

  private recordExecError(now: number): void {
    this.execErrors.push(now);
    const w = this.config.risk.executionErrorWindowSec * 1000;
    this.execErrors = this.execErrors.filter((t) => now - t <= w);
  }

  private async pollOrders(now: number): Promise<void> {
    for (const o of [...this.orders.values()]) {
      if (o.status !== 'submitted' && o.status !== 'unknown') continue;
      const adapter = this.adapters[o.mode];
      if (!adapter) {
        if (o.status !== 'unknown') {
          o.status = 'unknown';
          o.statusReason = `no ${o.mode} adapter available to confirm`;
          this.put({ orders: [o] });
        }
        continue;
      }
      let st: SwapStatus;
      if (o.status === 'unknown' || !o.txId) {
        const r = await this.call(adapter.name, 'execution', () => adapter.findByIdempotencyKey(o.idempotencyKey, now));
        if (!r.ok) continue;
        if (!r.value) {
          await this.resolveMissingOrder(o, now);
          continue;
        }
        o.txId = r.value.txId;
        st = r.value.status;
      } else {
        const r = await this.call(adapter.name, 'execution', () => adapter.getStatus(o.txId!, now));
        if (!r.ok) continue;
        st = r.value;
      }
      if (st.state === 'pending') {
        if (o.submittedAt && now - o.submittedAt > this.opts.orderUnknownAfterMs && o.status !== 'unknown') {
          o.status = 'unknown';
          o.statusReason = 'confirmation timeout';
          this.put({ orders: [o] });
          this.toReconciliation(o, 'transaction confirmation timed out', now);
        }
        continue;
      }
      if (st.state === 'unknown') {
        if (o.status !== 'unknown') {
          o.status = 'unknown';
          o.statusReason = st.error;
          this.put({ orders: [o] });
        }
        await this.resolveMissingOrder(o, now);
        continue;
      }
      if (st.state === 'confirmed') {
        if (o.purpose === 'entry') this.onEntryFilled(o, st, now);
        else this.onExitFilled(o, st, now);
      } else {
        if (o.purpose === 'entry') this.onEntryFailed(o, st.error, st.networkFeeQuote, now);
        else this.onExitFailed(o, st.error, st.networkFeeQuote, now);
      }
    }
  }

  private toReconciliation(o: Order, reason: string, now: number): void {
    const c = this.candidates.get(o.candidateId);
    if (c && (c.stage === 'EXECUTION_PENDING' || c.stage === 'EXIT_PENDING' || c.stage === 'OPEN')) this.move(c, 'RECONCILIATION_REQUIRED', reason);
    if (o.positionId) {
      const p = this.positions.get(o.positionId);
      if (p) {
        p.status = 'reconciliation_required';
        this.put({ positions: [p] });
        this.emit({ type: 'position', data: p });
      }
    }
    this.raise('critical', 'reconciliation', `Reconciliation required: $${o.symbol}`, `${o.purpose} order ${o.id}: ${reason}`, o.candidateId);
    this.audit({ agent: 'executor', action: 'RECONCILIATION_REQUIRED', result: 'warn', correlationId: o.candidateId, symbol: o.symbol, tokenAddress: o.tokenAddress, positionId: o.positionId, reason });
    this.recordExecError(now);
  }

  /** The venue has no record of the transaction. */
  private async resolveMissingOrder(o: Order, now: number): Promise<void> {
    if (o.mode === 'paper') {
      // The paper venue lives in memory: a missing record means it never executed.
      const fee = '0';
      if (o.purpose === 'entry') this.onEntryFailed(o, o.statusReason ?? 'simulated order lost (engine restart) — never filled', fee, now);
      else this.onExitFailed(o, o.statusReason ?? 'simulated order lost (engine restart) — never filled', fee, now);
      return;
    }
    // Live: without a transaction record we cannot know the outcome; keep flagged.
    if (o.status !== 'unknown') {
      o.status = 'unknown';
      this.put({ orders: [o] });
    }
    const c = this.candidates.get(o.candidateId);
    if (c && c.stage !== 'RECONCILIATION_REQUIRED') this.toReconciliation(o, 'transaction not found by idempotency key — verify wallet balances', now);
  }

  private onEntryFilled(o: Order, st: Extract<SwapStatus, { state: 'confirmed' }>, now: number): void {
    const c = this.candidates.get(o.candidateId);
    const prop = o.proposalId ? this.proposals.get(o.proposalId) : undefined;
    const qty = d(st.amountOut);
    let l = release(this.ledger(o.mode), o.reservedQuote, now);
    l = applyEntryFill(l, st.amountIn, st.networkFeeQuote, now);
    this.ledgers[o.mode] = l;
    const costBasis = d(st.amountIn).plus(st.networkFeeQuote);
    const fillPrice = d(st.amountIn).div(qty);
    const slip = d(o.quotedOut).gt(0) ? d(o.quotedOut).minus(qty).div(o.quotedOut).times(100) : d(0);
    o.status = 'confirmed';
    o.filledIn = st.amountIn;
    o.filledOut = st.amountOut;
    o.fillPrice = s(fillPrice, 18);
    o.networkFeeQuote = st.networkFeeQuote;
    o.slippagePct = s(slip, 4);
    o.settledAt = st.confirmedAt;
    this.trackSlippage(slip);
    const policy = prop?.exitPolicy ?? this.config.trading.exitPolicy;
    const pos: Position = {
      id: newId('pos', now),
      mode: o.mode,
      chain: o.chain,
      candidateId: o.candidateId,
      proposalId: o.proposalId ?? '',
      tokenAddress: o.tokenAddress,
      poolAddress: o.poolAddress,
      symbol: o.symbol,
      strategy: prop?.strategy ?? 'new_pool_entry',
      strategyVersion: prop?.strategyVersion ?? 'unknown',
      status: 'open',
      entryQty: s(qty, 12),
      qty: s(qty, 12),
      costBasis: s(costBasis, 8),
      openCostBasis: s(costBasis, 8),
      entryFillPrice: s(fillPrice, 18),
      entryFeesQuote: s(d(st.networkFeeQuote).plus(o.estSwapFeeQuote), 8),
      entryLiquidity: c?.snapshot?.liquidity ?? '0',
      exitFeesQuote: '0',
      proceeds: '0',
      realizedPnl: '0',
      exitPolicy: policy,
      highWaterValuePerToken: '0',
      stopPricePerToken: s(initialStop(costBasis.div(qty), policy.stopLossPct), 18),
      trailingActive: false,
      breakEvenArmed: false,
      tpLevelsHit: 0,
      exitFailures: 0,
      unsellable: false,
      openedAt: now,
      closedAt: null,
      lastMark: null,
      riskScore: prop?.riskScore ?? c?.riskScore ?? 0,
      entryRationale: prop ? `${prop.strategy}: ${prop.rationale}` : o.reason,
      exitReason: null,
      exitRationale: null,
      orderIds: [o.id],
    };
    o.positionId = pos.id;
    this.positions.set(pos.id, pos);
    const tx = this.txIndex.get(o.id);
    if (tx) {
      tx.status = 'confirmed';
      tx.networkFeeQuote = st.networkFeeQuote;
      tx.confirmedAt = st.confirmedAt;
    }
    const ev: PositionEvent = { id: newId('pe', now), positionId: pos.id, ts: now, type: 'opened', detail: `bought ${qty.toSignificantDigits(6).toString()} ${o.symbol} for ${st.amountIn} + fee ${st.networkFeeQuote}`, data: { fillPrice: o.fillPrice, slippagePct: o.slippagePct } };
    if (c) {
      c.positionId = pos.id;
      if (c.stage === 'EXECUTION_PENDING') this.move(c, 'OPEN', `filled at ${fillPrice.toSignificantDigits(6).toString()}`);
      else if (c.stage === 'RECONCILIATION_REQUIRED') this.move(c, 'OPEN', 'reconciled: entry confirmed');
    }
    this.counters.entered++;
    this.put({ orders: [o], positions: [pos], positionEvents: [ev], ledgers: [l], transactions: tx ? [tx] : [] });
    this.emit({ type: 'order', data: o });
    this.emit({ type: 'position', data: pos });
    this.audit({ agent: 'executor', action: 'ENTRY_FILLED', result: 'enter', correlationId: o.candidateId, positionId: pos.id, symbol: o.symbol, tokenAddress: o.tokenAddress, sizeQuote: st.amountIn, reason: `${pos.entryRationale} · slip ${slip.toFixed(2)}%`, strategyVersion: `${pos.strategy}@${pos.strategyVersion}`, metrics: { fillPrice: o.fillPrice, qty: pos.qty, fee: st.networkFeeQuote, slippagePct: o.slippagePct, stop: pos.stopPricePerToken } });
    this.raise('info', 'trade_entry', `Entered $${o.symbol}`, `${o.mode.toUpperCase()} · ${st.amountIn} ${l.currency} · ${pos.strategy}`, o.candidateId);
    this.agents.update('executor', now, { state: 'ok', currentTask: null, lastAction: `filled $${o.symbol}`, lastDecision: `slip ${slip.toFixed(2)}%` });
  }

  private onEntryFailed(o: Order, error: string, fee: string, now: number): void {
    const c = this.candidates.get(o.candidateId);
    let l = release(this.ledger(o.mode), o.reservedQuote, now);
    if (d(fee).gt(0)) l = applyFailedTx(l, fee, now);
    this.ledgers[o.mode] = l;
    o.status = 'failed';
    o.statusReason = error;
    o.networkFeeQuote = fee;
    o.settledAt = now;
    const tx = this.txIndex.get(o.id);
    if (tx) {
      tx.status = 'failed';
      tx.error = error;
      tx.networkFeeQuote = fee;
    }
    if (c && (c.stage === 'EXECUTION_PENDING' || c.stage === 'RECONCILIATION_REQUIRED')) this.move(c, 'FAILED', `entry failed: ${error}`);
    this.txStats[o.mode].failed++;
    this.counters.txFailures++;
    this.recordExecError(now);
    this.put({ orders: [o], ledgers: [l], transactions: tx ? [tx] : [] });
    this.emit({ type: 'order', data: o });
    this.audit({ agent: 'executor', action: 'ENTRY_FAILED', result: 'error', correlationId: o.candidateId, symbol: o.symbol, tokenAddress: o.tokenAddress, sizeQuote: o.amountIn, reason: `${error}${d(fee).gt(0) ? ` · fee ${fee} charged` : ''}` });
    this.raise('warning', 'execution_failure', `Entry failed: $${o.symbol}`, error, o.candidateId);
    this.agents.update('executor', now, { state: 'warning', currentTask: null, lastDecision: `entry failed $${o.symbol}: ${error}`, warning: error });
  }

  private trackSlippage(slip: Decimal): void {
    this.slippageSum = this.slippageSum.plus(slip);
    this.slippageN++;
    this.counters.avgSlippagePct = s(this.slippageSum.div(this.slippageN), 4);
  }

  // ════════════════════════ exit manager ════════════════════════

  private async manageExits(now: number): Promise<void> {
    const open = [...this.positions.values()].filter((p) => p.status === 'open');
    if (open.length === 0) {
      this.agents.update('exit', now, { state: 'idle', currentTask: null });
      return;
    }
    this.agents.update('exit', now, { state: 'working', currentTask: `monitoring ${open.length} position${open.length > 1 ? 's' : ''}` });
    for (const p of open) {
      const pool = this.candidates.get(p.candidateId)?.pool ?? this.poolFromPosition(p);
      const snapR = await this.snapshot(pool, now);
      const qR = d(p.qty).gt(0) ? await this.quote({ chain: p.chain, poolAddress: p.poolAddress, tokenAddress: p.tokenAddress, side: 'sell', amountIn: p.qty }, now) : { ok: false as const, error: 'zero quantity' };
      const ev = evaluateExit({ position: p, quote: qR.ok ? qR.value : null, quoteError: qR.ok ? null : qR.error, snapshot: snapR.ok ? snapR.value : null, now });
      Object.assign(p, ev.updates);
      p.lastMark = ev.mark;
      if (!qR.ok) {
        const n = (this.exitQuoteFailures.get(p.id) ?? 0) + 1;
        this.exitQuoteFailures.set(p.id, n);
        if (n === 3) this.raise('warning', 'exit_quote', `No exit quote: $${p.symbol}`, qR.error, p.candidateId);
      } else this.exitQuoteFailures.delete(p.id);
      const events: PositionEvent[] = ev.notes.map((n) => ({ id: newId('pe', now), positionId: p.id, ts: now, type: n.type, detail: n.detail, data: {} }));
      for (const n of ev.notes) this.audit({ agent: 'exit', action: n.type.toUpperCase(), result: 'info', correlationId: p.candidateId, positionId: p.id, symbol: p.symbol, tokenAddress: p.tokenAddress, reason: n.detail });
      this.put({ positions: [p], positionEvents: events });
      this.emit({ type: 'position', data: p });
      if (ev.action === 'exit' && ev.reason) {
        if (this.killSwitch && this.config.risk.killSwitchPolicy === 'block_all') {
          this.agents.update('exit', now, { state: 'blocked', warning: 'kill switch (block_all) — exits suspended' });
          continue;
        }
        if (p.unsellable && ev.reason !== 'manual') continue;
        await this.submitExit(p, ev.fraction, ev.reason, ev.detail, now);
      }
    }
    this.agents.update('exit', now, { state: 'ok', currentTask: `monitoring ${open.length}` });
  }

  private poolFromPosition(p: Position): PoolInfo {
    return {
      chain: p.chain,
      address: p.poolAddress,
      dex: 'unknown',
      token: { chain: p.chain, address: p.tokenAddress, symbol: p.symbol, name: p.symbol, decimals: 0 },
      quoteSymbol: 'USDC',
      quoteAddress: '',
      createdAt: p.openedAt,
      discoveredAt: p.openedAt,
      source: 'position',
    };
  }

  private async submitExit(p: Position, fraction: string, reason: ExitReason, detail: string, now: number): Promise<void> {
    const adapter = this.adapters[p.mode];
    if (!adapter) {
      this.raise('critical', 'execution_failure', `Cannot exit $${p.symbol}`, `no ${p.mode} execution adapter configured`, p.candidateId);
      return;
    }
    if ([...this.orders.values()].some((o) => o.positionId === p.id && ['created', 'submitted', 'unknown'].includes(o.status))) return;
    const frac = Decimal.min(1, Decimal.max(0, d(fraction)));
    let qtyToSell = d(p.qty).times(frac).toDecimalPlaces(12, Decimal.ROUND_DOWN);
    // Avoid leaving dust behind.
    if (d(p.qty).minus(qtyToSell).lte(d(p.qty).times(0.02))) qtyToSell = d(p.qty);
    if (qtyToSell.lte(0)) return;
    const qR = await this.quote({ chain: p.chain, poolAddress: p.poolAddress, tokenAddress: p.tokenAddress, side: 'sell', amountIn: s(qtyToSell, 12) }, now);
    if (!qR.ok) {
      this.audit({ agent: 'exit', action: 'EXIT_BLOCKED', result: 'warn', correlationId: p.candidateId, positionId: p.id, symbol: p.symbol, tokenAddress: p.tokenAddress, reason: `${reason}: no exit quote (${qR.error})` });
      return;
    }
    // Exits accept wider slippage than entries: being stuck is the larger risk.
    const slip = Decimal.min(25, d(this.config.trading.maxSlippagePct).times(reason === 'emergency' || reason === 'liquidity_deterioration' ? 4 : 2));
    const minOut = s(d(qR.value.expectedOut).times(d(1).minus(pct(slip))), 12);
    const idem = `exit:${p.id}:${p.orderIds.length}`;
    const order: Order = {
      id: newId('ord', now),
      idempotencyKey: idem,
      mode: p.mode,
      chain: p.chain,
      purpose: 'exit',
      side: 'sell',
      candidateId: p.candidateId,
      positionId: p.id,
      proposalId: p.proposalId,
      tokenAddress: p.tokenAddress,
      poolAddress: p.poolAddress,
      symbol: p.symbol,
      amountIn: s(qtyToSell, 12),
      minOut,
      quotedOut: qR.value.expectedOut,
      maxSlippagePct: s(slip, 4),
      priorityFeeQuote: this.config.trading.priorityFeeQuote,
      reservedQuote: '0',
      estSwapFeeQuote: qR.value.swapFeeQuote,
      status: 'created',
      statusReason: null,
      txId: null,
      filledIn: null,
      filledOut: null,
      fillPrice: null,
      networkFeeQuote: null,
      slippagePct: null,
      reason: `${reason}: ${detail}`,
      createdAt: now,
      submittedAt: null,
      settledAt: null,
      attempts: 0,
    };
    const swap = { idempotencyKey: idem, chain: p.chain, poolAddress: p.poolAddress, tokenAddress: p.tokenAddress, side: 'sell' as const, amountIn: order.amountIn, minOut, priorityFeeQuote: order.priorityFeeQuote };
    const sim = await this.call(adapter.name, 'execution', () => adapter.simulate(swap, now));
    if (sim.ok && !sim.value.ok) {
      this.onExitSimulationFailed(p, sim.value.error ?? 'simulation failed', reason, now);
      return;
    }
    p.orderIds.push(order.id);
    p.status = 'exit_pending';
    p.exitReason = reason;
    p.exitRationale = detail;
    this.orders.set(order.id, order);
    const c = this.candidates.get(p.candidateId);
    if (c && c.stage === 'OPEN') this.move(c, 'EXIT_PENDING', `${reason}: ${detail}`);
    const pe: PositionEvent = { id: newId('pe', now), positionId: p.id, ts: now, type: 'exit_triggered', detail: `${reason}: ${detail}`, data: { fraction: s(frac, 4), qty: order.amountIn } };
    this.put({ orders: [order], positions: [p], positionEvents: [pe] });
    await this.flush();
    order.attempts++;
    const sub = await this.call(adapter.name, 'execution', () => adapter.submit(swap, now));
    if (!sub.ok) {
      order.status = 'unknown';
      order.statusReason = `submit error: ${sub.error}`;
      order.submittedAt = now;
      this.put({ orders: [order] });
      this.recordExecError(now);
      return;
    }
    order.status = 'submitted';
    order.txId = sub.value.txId;
    order.submittedAt = sub.value.submittedAt;
    const tx: ChainTransaction = { id: newId('tx', now), orderId: order.id, mode: p.mode, chain: p.chain, signature: sub.value.txId, status: 'pending', error: null, networkFeeQuote: null, submittedAt: now, confirmedAt: null, simulated: p.mode === 'paper', explorerUrl: adapter.explorerUrl?.(sub.value.txId) ?? null };
    this.txIndex.set(order.id, tx);
    this.txStats[p.mode].submitted++;
    this.counters.txSubmitted++;
    this.put({ orders: [order], transactions: [tx] });
    this.emit({ type: 'order', data: order });
    this.emit({ type: 'position', data: p });
    this.audit({ agent: 'exit', action: 'EXIT_TRIGGERED', result: 'exit', correlationId: p.candidateId, positionId: p.id, symbol: p.symbol, tokenAddress: p.tokenAddress, reason: `${reason}: ${detail}`, metrics: { fraction: s(frac, 4), quotedOut: qR.value.expectedOut, slipCap: s(slip, 2), orderId: order.id } });
    this.agents.update('exit', now, { lastAction: `${reason} $${p.symbol}`, lastDecision: detail });
  }

  private onExitSimulationFailed(p: Position, error: string, reason: ExitReason, now: number): void {
    p.exitFailures++;
    const restricted = /restrict|honeypot|frozen|freeze/i.test(error);
    const pe: PositionEvent = { id: newId('pe', now), positionId: p.id, ts: now, type: 'exit_failed', detail: `simulation failed: ${error}`, data: { failures: p.exitFailures } };
    this.audit({ agent: 'exit', action: 'EXIT_SIMULATION_FAILED', result: 'error', correlationId: p.candidateId, positionId: p.id, symbol: p.symbol, tokenAddress: p.tokenAddress, reason: `${reason}: ${error}` });
    if ((restricted || p.exitFailures >= this.opts.unsellableAfterFailures) && !p.unsellable) {
      p.unsellable = true;
      this.raise('critical', 'unsellable', `Unsellable: $${p.symbol}`, `exit failed ${p.exitFailures}× (${error}); valued at 0 — review or write off`, p.candidateId);
    }
    this.put({ positions: [p], positionEvents: [pe] });
    this.emit({ type: 'position', data: p });
  }

  private onExitFilled(o: Order, st: Extract<SwapStatus, { state: 'confirmed' }>, now: number): void {
    const p = o.positionId ? this.positions.get(o.positionId) : undefined;
    o.status = 'confirmed';
    o.filledIn = st.amountIn;
    o.filledOut = st.amountOut;
    o.fillPrice = s(d(st.amountOut).div(st.amountIn), 18);
    o.networkFeeQuote = st.networkFeeQuote;
    const slip = d(o.quotedOut).gt(0) ? d(o.quotedOut).minus(st.amountOut).div(o.quotedOut).times(100) : d(0);
    o.slippagePct = s(slip, 4);
    o.settledAt = st.confirmedAt;
    this.trackSlippage(slip);
    const tx = this.txIndex.get(o.id);
    if (tx) {
      tx.status = 'confirmed';
      tx.networkFeeQuote = st.networkFeeQuote;
      tx.confirmedAt = st.confirmedAt;
    }
    if (!p) {
      this.put({ orders: [o], transactions: tx ? [tx] : [] });
      this.raise('critical', 'reconciliation', 'Exit fill without position', `order ${o.id}`, o.candidateId);
      return;
    }
    const sold = d(st.amountIn);
    const portion = Decimal.min(1, sold.div(p.qty));
    const costPortion = d(p.openCostBasis).times(portion);
    const l = applyExitFill(this.ledger(p.mode), st.amountOut, st.networkFeeQuote, s(costPortion, 8), now);
    this.ledgers[p.mode] = l;
    const pnl = d(st.amountOut).minus(st.networkFeeQuote).minus(costPortion);
    p.qty = s(max(0, d(p.qty).minus(sold)), 12);
    p.openCostBasis = s(max(0, d(p.openCostBasis).minus(costPortion)), 8);
    p.proceeds = s(d(p.proceeds).plus(st.amountOut), 8);
    p.exitFeesQuote = s(d(p.exitFeesQuote).plus(st.networkFeeQuote).plus(o.estSwapFeeQuote), 8);
    p.realizedPnl = s(d(p.realizedPnl).plus(pnl), 8);
    p.exitFailures = 0;
    const closed = d(p.qty).lte(0);
    const events: PositionEvent[] = [];
    const c = this.candidates.get(p.candidateId);
    if (closed) {
      p.status = 'closed';
      p.closedAt = now;
      p.lastMark = p.lastMark ? { ...p.lastMark, liquidationValue: '0', markValue: '0', unrealizedPnl: '0' } : null;
      events.push({ id: newId('pe', now), positionId: p.id, ts: now, type: 'closed', detail: `closed: ${p.exitReason} · net ${d(p.realizedPnl).toFixed(4)}`, data: { realizedPnl: p.realizedPnl } });
      if (c && (c.stage === 'EXIT_PENDING' || c.stage === 'RECONCILIATION_REQUIRED')) this.move(c, 'CLOSED', `${p.exitReason}: net ${d(p.realizedPnl).toFixed(2)}`);
      const trade = this.buildTrade(p, now, 'confirmed');
      this.trades.push(trade);
      this.onTradeClosed(trade, now);
      this.put({ trades: [trade] });
      this.counters.exited++;
    } else {
      p.status = 'open';
      if (p.exitReason === 'take_profit') p.tpLevelsHit++;
      events.push({ id: newId('pe', now), positionId: p.id, ts: now, type: 'partial_exit', detail: `sold ${portion.times(100).toFixed(1)}% (${p.exitReason}) · realized ${pnl.toFixed(4)}`, data: { realized: s(pnl, 8) } });
      if (c && (c.stage === 'EXIT_PENDING' || c.stage === 'RECONCILIATION_REQUIRED')) this.move(c, 'OPEN', `partial exit: ${p.exitReason}`);
    }
    this.put({ orders: [o], positions: [p], positionEvents: events, ledgers: [l], transactions: tx ? [tx] : [] });
    this.emit({ type: 'order', data: o });
    this.emit({ type: 'position', data: p });
    this.audit({ agent: 'executor', action: closed ? 'EXIT_FILLED' : 'PARTIAL_EXIT', result: 'exit', correlationId: p.candidateId, positionId: p.id, symbol: p.symbol, tokenAddress: p.tokenAddress, sizeQuote: st.amountOut, reason: `${p.exitReason}: ${p.exitRationale ?? ''} · pnl ${pnl.gte(0) ? '+' : ''}${pnl.toFixed(4)}`, metrics: { proceeds: st.amountOut, fee: st.networkFeeQuote, slippagePct: o.slippagePct, realizedPnl: p.realizedPnl } });
    if (closed) {
      this.audit({ agent: 'equity', action: 'PNL_RECONCILED', result: 'ok', correlationId: p.candidateId, positionId: p.id, symbol: p.symbol, tokenAddress: p.tokenAddress, reason: `net ${d(p.realizedPnl).gte(0) ? '+' : ''}${d(p.realizedPnl).toFixed(4)} after fees ${d(p.entryFeesQuote).plus(p.exitFeesQuote).toFixed(4)} · cash ${d(l.cash).toFixed(2)}`, metrics: { netPnl: p.realizedPnl, cash: l.cash } });
      this.raise(d(p.realizedPnl).gte(0) ? 'info' : 'warning', p.exitReason === 'stop_loss' ? 'stop_loss' : p.exitReason === 'take_profit' ? 'take_profit' : 'trade_exit', `Exited $${p.symbol}`, `${p.exitReason} · net ${d(p.realizedPnl).toFixed(2)}`, p.candidateId);
      this.snapshotEquity(now);
    }
    this.agents.update('equity', now, { state: 'ok', lastAction: `${closed ? 'closed' : 'partial'} $${p.symbol}`, lastDecision: `cash ${d(l.cash).toFixed(2)}` });
  }

  private onExitFailed(o: Order, error: string, fee: string, now: number): void {
    const p = o.positionId ? this.positions.get(o.positionId) : undefined;
    o.status = 'failed';
    o.statusReason = error;
    o.networkFeeQuote = fee;
    o.settledAt = now;
    const tx = this.txIndex.get(o.id);
    if (tx) {
      tx.status = 'failed';
      tx.error = error;
      tx.networkFeeQuote = fee;
    }
    if (d(fee).gt(0)) this.ledgers[o.mode] = applyFailedTx(this.ledger(o.mode), fee, now);
    this.txStats[o.mode].failed++;
    this.counters.txFailures++;
    this.recordExecError(now);
    const events: PositionEvent[] = [];
    if (p) {
      p.status = 'open';
      p.exitFailures++;
      if (d(fee).gt(0)) p.exitFeesQuote = s(d(p.exitFeesQuote).plus(fee), 8);
      if (d(fee).gt(0)) p.realizedPnl = s(d(p.realizedPnl).minus(fee), 8);
      events.push({ id: newId('pe', now), positionId: p.id, ts: now, type: 'exit_failed', detail: error, data: { failures: p.exitFailures } });
      const c = this.candidates.get(p.candidateId);
      if (c && (c.stage === 'EXIT_PENDING' || c.stage === 'RECONCILIATION_REQUIRED')) this.move(c, 'OPEN', `exit failed: ${error}`);
      if ((/restrict|honeypot|frozen/i.test(error) || p.exitFailures >= this.opts.unsellableAfterFailures) && !p.unsellable) {
        p.unsellable = true;
        this.raise('critical', 'unsellable', `Unsellable: $${p.symbol}`, `exit failed ${p.exitFailures}× (${error}); valued at 0`, p.candidateId);
      }
      this.put({ positions: [p] });
      this.emit({ type: 'position', data: p });
    }
    this.put({ orders: [o], positionEvents: events, ledgers: [this.ledger(o.mode)], transactions: tx ? [tx] : [] });
    this.emit({ type: 'order', data: o });
    this.audit({ agent: 'executor', action: 'EXIT_FAILED', result: 'error', correlationId: o.candidateId, positionId: o.positionId, symbol: o.symbol, tokenAddress: o.tokenAddress, reason: `${error} — position remains open and monitored` });
    this.raise('warning', 'execution_failure', `Exit failed: $${o.symbol}`, error, o.candidateId);
  }

  private buildTrade(p: Position, now: number, txStatus: Trade['txStatus']): Trade {
    const fees = d(p.entryFeesQuote).plus(p.exitFeesQuote);
    const exitOrders = p.orderIds.map((id) => this.orders.get(id)).filter((o): o is Order => !!o && o.status === 'confirmed');
    const slips = exitOrders.map((o) => d(o.slippagePct ?? 0));
    const soldQty = d(p.entryQty);
    return {
      id: newId('trd', now),
      positionId: p.id,
      mode: p.mode,
      chain: p.chain,
      tokenAddress: p.tokenAddress,
      poolAddress: p.poolAddress,
      symbol: p.symbol,
      strategy: p.strategy,
      candidateId: p.candidateId,
      entryAt: p.openedAt,
      exitAt: now,
      entryPrice: p.entryFillPrice,
      exitPrice: soldQty.gt(0) ? s(d(p.proceeds).div(soldQty), 18) : '0',
      size: p.costBasis,
      qty: p.entryQty,
      grossPnl: s(d(p.realizedPnl).plus(fees), 8),
      fees: s(fees, 8),
      netPnl: p.realizedPnl,
      returnPct: d(p.costBasis).gt(0) ? s(d(p.realizedPnl).div(p.costBasis).times(100), 4) : '0',
      holdSec: Math.round((now - p.openedAt) / 1000),
      exitReason: p.exitReason ?? 'unknown',
      txStatus,
      slippagePct: slips.length ? s(slips.reduce((a, b) => a.plus(b), d(0)).div(slips.length), 4) : '0',
    };
  }

  private onTradeClosed(t: Trade, now: number): void {
    const m = t.mode;
    if (d(t.netPnl).gt(0)) this.consecutiveLosses[m] = 0;
    else {
      this.consecutiveLosses[m]++;
      if (this.consecutiveLosses[m] >= this.config.risk.consecutiveLossLimit) {
        this.lossCooldownUntil[m] = now + this.config.risk.consecutiveLossCooldownSec * 1000;
        this.raise('warning', 'consecutive_losses', 'Consecutive-loss breaker', `${this.consecutiveLosses[m]} losses in a row — entries paused for ${Math.round(this.config.risk.consecutiveLossCooldownSec / 60)}m`);
      }
    }
  }

  private recomputeLossStreak(m: TradingMode): void {
    let n = 0;
    for (let i = this.trades.length - 1; i >= 0; i--) {
      const t = this.trades[i]!;
      if (t.mode !== m) continue;
      if (d(t.netPnl).gt(0)) break;
      n++;
    }
    this.consecutiveLosses[m] = n;
  }

  // ════════════════════════ accounting / breakers ════════════════════════

  ledger(mode: TradingMode): Ledger {
    const l = this.ledgers[mode];
    if (!l) throw new EngineError(`${mode} ledger not initialized`, 'unavailable');
    return l;
  }

  private snapshotEquity(now: number): void {
    for (const mode of ['paper', 'live'] as const) {
      const l = this.ledgers[mode];
      if (!l) continue;
      const positions = [...this.positions.values()];
      const snap = equitySnapshot(l, positions, now);
      const touched = touchLedger(l, d(snap.equity), now);
      if (touched.dayKey !== l.dayKey || touched.peakEquity !== l.peakEquity) {
        this.ledgers[mode] = touched;
        this.put({ ledgers: [touched] });
      }
      this.equity[mode].push(snap);
      if (this.equity[mode].length > 3000) this.equity[mode].splice(0, this.equity[mode].length - 3000);
      this.put({ equity: [snap] });
      this.emit({ type: 'equity', data: snap });
      if (mode === this.mode) this.agents.update('equity', now, { state: 'ok', currentTask: `equity ${d(snap.equity).toFixed(2)}`, lastDecision: `dd ${d(snap.drawdownPct).toFixed(2)}% · ${snap.openPositions} open` });
    }
  }

  private setBreaker(id: string, tripped: boolean, reason: string | null, now: number, until: number | null = null): void {
    const b = this.breakers.get(id)!;
    if (b.tripped === tripped) {
      if (tripped) b.reason = reason;
      return;
    }
    b.tripped = tripped;
    b.reason = tripped ? reason : null;
    b.since = tripped ? now : null;
    b.until = until;
    this.audit({ agent: 'orchestrator', action: tripped ? 'BREAKER_TRIPPED' : 'BREAKER_RESET', result: tripped ? 'blocked' : 'ok', reason: `${b.label}${reason ? `: ${reason}` : ''}` });
    if (tripped) this.raise(id === 'daily_loss' || id === 'drawdown' ? 'critical' : 'warning', `breaker_${id}`, `Circuit breaker: ${b.label}`, reason ?? '');
  }

  private updateBreakers(now: number): void {
    const th = this.config.risk.thresholds;
    const staleAfter = th.maxDataAgeSec * 2000;
    const stale = this.lastMarketDataAt === null ? now - this.startedAt > staleAfter : now - this.lastMarketDataAt > staleAfter;
    this.setBreaker('stale_data', stale, stale ? `no market data for ${this.lastMarketDataAt ? Math.round((now - this.lastMarketDataAt) / 1000) : '∞'}s` : null, now);
    const bad = [...this.providers.values()].filter((p) => p.kind !== 'execution' && p.consecutiveFailures >= 5);
    this.setBreaker('provider_health', bad.length > 0, bad.length ? bad.map((b) => `${b.provider}: ${b.lastError}`).join('; ') : null, now);
    const l = this.ledgers[this.mode];
    if (l) {
      const v = valuePortfolio(l, [...this.positions.values()]);
      const eq = s(v.equity, 8);
      const daily = dailyPnlPct(eq, l.dayStartEquity);
      const maxDaily = min(this.config.risk.maxDailyLossPct, this.hard.maxDailyLossPct);
      this.setBreaker('daily_loss', daily.neg().gte(maxDaily), `daily P&L ${daily.toFixed(2)}% (limit -${maxDaily.toFixed(2)}%)`, now);
      const dd = drawdownPct(eq, s(Decimal.max(d(l.peakEquity), v.equity), 8));
      const maxDd = min(this.config.risk.maxDrawdownPct, this.hard.maxDrawdownPct);
      this.setBreaker('drawdown', dd.gte(maxDd), `drawdown ${dd.toFixed(2)}% (limit ${maxDd.toFixed(2)}%)`, now);
    }
    const cd = this.lossCooldownUntil[this.mode];
    this.setBreaker('consecutive_losses', cd !== null && now < cd, `${this.consecutiveLosses[this.mode]} consecutive losses`, now, cd);
    const w = this.config.risk.executionErrorWindowSec * 1000;
    this.execErrors = this.execErrors.filter((t) => now - t <= w);
    this.setBreaker('execution_errors', this.execErrors.length >= this.config.risk.maxExecutionErrors, `${this.execErrors.length} execution errors in ${this.config.risk.executionErrorWindowSec}s`, now);
    const noQuote = [...this.exitQuoteFailures.entries()].filter(([, n]) => n >= 3);
    this.setBreaker('exit_quotes', noQuote.length > 0, `${noQuote.length} open position(s) without a reliable exit quote`, now);
  }

  private gc(now: number): void {
    // Drop terminal candidates from memory after a while (they remain in the store).
    if (this.tickCount % 30 !== 0) return;
    for (const [id, c] of this.candidates) {
      if (isTerminal(c.stage) && now - c.updatedAt > 10 * 60_000) {
        this.candidates.delete(id);
        this.poolIndex.delete(c.pool.address);
        this.history.delete(c.pool.address);
        this.reports.delete(id);
        this.assessments.delete(id);
        this.lastSkipReason.delete(id);
        this.lastSnapshotPersist.delete(c.pool.address);
      }
    }
    for (const [id, o] of this.orders) {
      if ((o.status === 'confirmed' || o.status === 'failed' || o.status === 'cancelled') && now - (o.settledAt ?? o.createdAt) > 30 * 60_000) {
        this.orders.delete(id);
        this.txIndex.delete(id);
      }
    }
    for (const [id, p] of this.proposals) if (p.status !== 'awaiting_approval' && now - p.createdAt > 30 * 60_000) this.proposals.delete(id);
    for (const [id, p] of this.positions) if (p.status === 'closed' && now - (p.closedAt ?? 0) > 6 * 3600_000) this.positions.delete(id);
    if (this.tokenSeen.size > 20_000) this.tokenSeen = new Set([...this.tokenSeen].slice(-10_000));
  }

  // ════════════════════════ commands (API) ════════════════════════

  pauseEntries(reason: string): void {
    this.entriesPaused = true;
    this.pauseReason = reason;
  }

  async setPaused(paused: boolean, actor: string): Promise<void> {
    await this.command(async () => {
      this.entriesPaused = paused;
      this.pauseReason = paused ? `paused by ${actor}` : null;
      this.audit({ agent: 'orchestrator', action: paused ? 'ENTRIES_PAUSED' : 'ENTRIES_RESUMED', result: 'info', reason: `by ${actor}` });
      if (paused) this.raise('info', 'emergency_pause', 'Entries paused', `by ${actor}`);
    });
  }

  async setKillSwitch(on: boolean, actor: string): Promise<void> {
    await this.command(async (now) => {
      this.killSwitch = on;
      const policy = this.config.risk.killSwitchPolicy;
      this.audit({ agent: 'orchestrator', action: on ? 'KILL_SWITCH_ON' : 'KILL_SWITCH_OFF', result: on ? 'blocked' : 'info', reason: `by ${actor} · policy ${policy}` });
      this.raise(on ? 'critical' : 'info', 'emergency_pause', on ? 'KILL SWITCH ACTIVATED' : 'Kill switch released', `by ${actor} · position policy: ${policy}`);
      // Cancel anything not yet submitted.
      if (on) {
        for (const c of this.candidates.values()) {
          if (c.stage === 'TRADE_PROPOSED' || c.stage === 'RISK_APPROVED') {
            const p = c.proposalId ? this.proposals.get(c.proposalId) : undefined;
            if (p) {
              p.status = 'cancelled';
              p.statusReason = 'kill switch';
              this.put({ proposals: [p] });
            }
            this.move(c, 'CANCELLED', 'kill switch');
          }
        }
        if (policy === 'close_all') {
          for (const p of [...this.positions.values()].filter((x) => x.status === 'open')) await this.submitExit(p, '1', 'emergency', 'kill switch: close all', now);
        }
      }
    });
  }

  async closePosition(id: string, actor: string): Promise<void> {
    await this.command(async (now) => {
      const p = this.positions.get(id);
      if (!p) throw new EngineError('position not found', 'not_found');
      if (p.status !== 'open') throw new EngineError(`position is ${p.status}`, 'conflict');
      if (this.killSwitch && this.config.risk.killSwitchPolicy === 'block_all') throw new EngineError('kill switch (block_all) prevents orders', 'forbidden');
      this.audit({ agent: 'orchestrator', action: 'MANUAL_CLOSE', result: 'info', positionId: id, correlationId: p.candidateId, symbol: p.symbol, tokenAddress: p.tokenAddress, reason: `requested by ${actor}` });
      await this.submitExit(p, '1', 'manual', `manual close by ${actor}`, now);
    });
  }

  async writeOff(id: string, actor: string): Promise<void> {
    await this.command(async (now) => {
      const p = this.positions.get(id);
      if (!p) throw new EngineError('position not found', 'not_found');
      if (!p.unsellable) throw new EngineError('only positions flagged unsellable can be written off', 'conflict');
      if (p.status !== 'open') throw new EngineError(`position is ${p.status}`, 'conflict');
      const loss = p.openCostBasis;
      this.ledgers[p.mode] = applyWriteOff(this.ledger(p.mode), loss, now);
      p.realizedPnl = s(d(p.realizedPnl).minus(loss), 8);
      p.openCostBasis = '0';
      p.qty = '0';
      p.status = 'closed';
      p.closedAt = now;
      p.exitReason = 'written_off';
      p.exitRationale = `written off by ${actor}: unsellable`;
      const c = this.candidates.get(p.candidateId);
      if (c && c.stage === 'OPEN') {
        this.move(c, 'EXIT_PENDING', 'write-off');
        this.move(c, 'CLOSED', 'written off');
      }
      const trade = this.buildTrade(p, now, 'written_off');
      this.trades.push(trade);
      this.onTradeClosed(trade, now);
      this.put({ positions: [p], trades: [trade], ledgers: [this.ledger(p.mode)], positionEvents: [{ id: newId('pe', now), positionId: p.id, ts: now, type: 'closed', detail: p.exitRationale, data: { loss } }] });
      this.emit({ type: 'position', data: p });
      this.audit({ agent: 'equity', action: 'WRITE_OFF', result: 'warn', positionId: p.id, correlationId: p.candidateId, symbol: p.symbol, tokenAddress: p.tokenAddress, reason: `${p.exitRationale} · loss ${loss}` });
    });
  }

  async decideProposal(id: string, approve: boolean, actor: string): Promise<void> {
    await this.command(async (now) => {
      const p = this.proposals.get(id);
      if (!p) throw new EngineError('proposal not found', 'not_found');
      if (p.status !== 'awaiting_approval') throw new EngineError(`proposal is ${p.status}`, 'conflict');
      const c = this.candidates.get(p.candidateId);
      if (!c || c.stage !== 'TRADE_PROPOSED') throw new EngineError('candidate no longer awaiting execution', 'conflict');
      if (now > p.expiresAt) {
        this.expireProposal(c, p, 'approval arrived after expiry');
        throw new EngineError('proposal expired', 'conflict');
      }
      this.audit({ agent: 'orchestrator', action: approve ? 'PROPOSAL_APPROVED' : 'PROPOSAL_REJECTED', result: approve ? 'pass' : 'reject', correlationId: c.id, symbol: p.symbol, tokenAddress: p.tokenAddress, sizeQuote: p.size, reason: `by ${actor}` });
      if (!approve) {
        p.status = 'rejected';
        p.statusReason = `rejected by ${actor}`;
        this.put({ proposals: [p] });
        this.move(c, 'REJECTED', p.statusReason);
        return;
      }
      await this.approveAndExecute(c, p, actor, now);
    });
  }

  async updateConfig(next: unknown, actor: string, note = ''): Promise<{ version: number }> {
    const parsed = EngineConfigSchema.safeParse(next);
    if (!parsed.success) throw new EngineError(`invalid config: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, 'invalid');
    const v = checkHardLimits(parsed.data, this.hard);
    if (v.length) throw new EngineError(`hard limit violation: ${v.map((x) => `${x.path} ${x.message}`).join('; ')}`, 'forbidden');
    return this.command(async (now) => {
      const prev = this.config;
      const cfg = parsed.data;
      // Exit policy changes create a new policy version; open positions keep theirs.
      if (JSON.stringify({ ...cfg.trading.exitPolicy, version: 0 }) !== JSON.stringify({ ...prev.trading.exitPolicy, version: 0 })) cfg.trading.exitPolicy.version = prev.trading.exitPolicy.version + 1;
      if (cfg.trading.chain !== this.market.chain) throw new EngineError(`chain ${cfg.trading.chain} not served by configured market provider (${this.market.chain})`, 'invalid');
      this.config = cfg;
      this.configVersion++;
      const rec: ConfigVersion = { version: this.configVersion, config: cfg, changedBy: actor, changedAt: now, note };
      this.put({ configs: [rec] });
      const changes = diffKeys(prev, cfg);
      this.audit({ agent: 'orchestrator', action: 'CONFIG_CHANGED', result: 'info', reason: `v${this.configVersion} by ${actor}: ${changes.slice(0, 12).join(', ')}${changes.length > 12 ? '…' : ''}`, metrics: { version: this.configVersion, changed: changes.length } });
      return { version: this.configVersion };
    });
  }

  /** Live activation. Requires env enablement, an adapter and explicit confirmation. */
  async authorizeLive(input: { confirm: string; walletLabel: string }, actor: string): Promise<void> {
    if (!this.opts.liveTradingEnabled) throw new EngineError('live trading is disabled on this server (LIVE_TRADING_ENABLED=false)', 'forbidden');
    const adapter = this.adapters.live;
    if (!adapter) throw new EngineError('no live execution adapter configured', 'unavailable');
    if (input.confirm !== 'ENABLE LIVE TRADING') throw new EngineError('confirmation phrase mismatch', 'invalid');
    if (input.walletLabel !== adapter.walletLabel) throw new EngineError('wallet confirmation does not match the configured live wallet', 'invalid');
    await this.command(async (now) => {
      if (!this.ledgers.live) {
        const bal = adapter.getQuoteBalance ? await adapter.getQuoteBalance(now) : null;
        if (bal === null) throw new EngineError('cannot read live wallet balance to initialise the live ledger', 'unavailable');
        this.ledgers.live = newLedger('live', bal, now);
        this.put({ ledgers: [this.ledgers.live] });
      }
      this.mode = 'live';
      this.liveAuthorized = true;
      this.audit({ agent: 'orchestrator', action: 'LIVE_AUTHORIZED', result: 'warn', reason: `live trading authorized by ${actor} on ${adapter.chain} wallet ${adapter.walletLabel}` });
      this.raise('critical', 'live_enabled', 'LIVE TRADING ENABLED', `by ${actor} · wallet ${adapter.walletLabel}`);
    });
  }

  async revokeLive(actor: string): Promise<void> {
    await this.command(async () => {
      this.mode = 'paper';
      this.liveAuthorized = false;
      this.audit({ agent: 'orchestrator', action: 'LIVE_REVOKED', result: 'info', reason: `returned to paper mode by ${actor}` });
      this.raise('info', 'live_disabled', 'Live trading disabled', `by ${actor}`);
    });
  }

  async adjustPaperBalance(kind: 'deposit' | 'withdraw', amount: string, actor: string): Promise<Ledger> {
    return this.command(async (now) => {
      let l = this.ledger('paper');
      l = kind === 'deposit' ? applyDeposit(l, amount, now) : applyWithdrawal(l, amount, now);
      this.ledgers.paper = l;
      this.put({ ledgers: [l] });
      this.audit({ agent: 'equity', action: kind === 'deposit' ? 'DEPOSIT' : 'WITHDRAWAL', result: 'info', sizeQuote: amount, reason: `paper ${kind} ${amount} by ${actor} (not counted as P&L)` });
      this.snapshotEquity(now);
      return l;
    });
  }

  async acknowledgeAlert(id: string): Promise<void> {
    await this.command(async () => {
      const a = this.alerts.find((x) => x.id === id);
      if (!a) throw new EngineError('alert not found', 'not_found');
      a.acknowledged = true;
      this.put({ alerts: [a] });
      this.emit({ type: 'alert', data: a });
    });
  }

  // ════════════════════════ read models ════════════════════════

  status(): EngineStatus {
    const providers = [...this.providers.values()];
    const breakers = [...this.breakers.values()];
    const down = providers.some((p) => p.kind === 'market' && !p.ok);
    const degraded = breakers.some((b) => b.tripped) || providers.some((p) => !p.ok);
    return {
      name: this.opts.name,
      version: this.opts.version,
      mode: this.mode,
      liveAvailable: this.opts.liveTradingEnabled && !!this.adapters.live,
      liveAuthorized: this.liveAuthorized,
      liveWallet: this.adapters.live?.walletLabel ?? null,
      chain: this.market.chain,
      marketSource: this.market.name,
      simulatedMarket: this.market.simulated,
      // Compared against the wall clock so a stalled loop is reported as not running.
      running: this.initialized && this.lastTickAt !== null && this.wall() - this.lastTickAt < 15_000,
      entriesPaused: this.entriesPaused,
      pauseReason: this.pauseReason,
      killSwitch: this.killSwitch,
      killSwitchPolicy: this.config.risk.killSwitchPolicy,
      startedAt: this.startedAt,
      now: this.now,
      lastMarketDataAt: this.lastMarketDataAt,
      lastTickAt: this.lastTickAt,
      tickCount: this.tickCount,
      health: down ? 'down' : degraded ? 'degraded' : 'ok',
      breakers,
      providers,
      configVersion: this.configVersion,
      persistent: this.store.persistent,
    };
  }

  countersView(): PipelineCounters {
    return { ...this.counters };
  }

  performanceFor(mode: TradingMode): PerformanceStats {
    const l = this.ledgers[mode] ?? newLedger(mode, '0', this.now);
    return computePerformance(l, [...this.positions.values()], this.trades, this.equity[mode], this.txStats[mode]);
  }

  performance(): { paper: PerformanceStats; live: PerformanceStats } {
    return { paper: this.performanceFor('paper'), live: this.performanceFor('live') };
  }

  candidateList(limit = 120): Candidate[] {
    return [...this.candidates.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
  }

  getCandidate(id: string): Candidate | undefined {
    return this.candidates.get(id);
  }

  getAssessment(candidateId: string): RiskAssessment | undefined {
    return this.assessments.get(candidateId);
  }

  getHistory(poolAddress: string): MarketSnapshot[] {
    return this.history.get(poolAddress) ?? [];
  }

  positionList(): Position[] {
    return [...this.positions.values()].sort((a, b) => b.openedAt - a.openedAt);
  }

  getPosition(id: string): Position | undefined {
    return this.positions.get(id);
  }

  orderList(): Order[] {
    return [...this.orders.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  pendingApprovals(): TradeProposal[] {
    return [...this.proposals.values()].filter((p) => p.status === 'awaiting_approval');
  }

  alertList(): Alert[] {
    return [...this.alerts].reverse();
  }

  equitySeries(mode: TradingMode): EquitySnapshot[] {
    return this.equity[mode];
  }

  /** Pools that must survive a simulated-market snapshot (open positions / live candidates). */
  retainedPools(): Set<string> {
    const s = new Set<string>();
    for (const p of this.positions.values()) if (p.status !== 'closed' && p.status !== 'failed') s.add(p.poolAddress);
    return s;
  }

  dashboard(): DashboardSnapshot {
    const eq = (m: TradingMode) => downsample(this.equity[m], 400);
    return {
      status: this.status(),
      agents: this.agents.all(),
      candidates: this.candidateList(),
      positions: this.positionList().slice(0, 60),
      performance: this.performance(),
      equity: { paper: eq('paper'), live: eq('live') },
      audit: this.log.recent.slice(-250),
      alerts: this.alertList().slice(0, 50),
      counters: this.countersView(),
      pendingApprovals: this.pendingApprovals(),
    };
  }
}

/** Recovery path: stages without a direct EXPIRED edge (e.g. SCREENING) are expired explicitly. */
function expireOnRestart(c: Candidate, now: number): void {
  const reason = 'engine restarted — evaluation state discarded';
  c.stage = 'EXPIRED';
  c.stageReason = reason;
  c.updatedAt = now;
  c.stageHistory.push({ stage: 'EXPIRED', ts: now, reason });
}

function costPct(q: Quote, size: Decimal): string {
  if (size.lte(0)) return '0';
  const impactCost = size.times(pct(Decimal.max(0, d(q.priceImpactPct))));
  return s(d(q.swapFeeQuote).plus(q.networkFeeQuote).plus(impactCost).div(size).times(100), 6);
}

function sizingMetrics(r: SizingResult): Record<string, string | number | boolean | null> {
  return {
    size: r.size,
    maxAllowed: r.maxAllowed,
    equity: s(r.equity, 2),
    binding: r.constraints.find((c) => c.binding)?.name ?? null,
    estDownside: s(r.estDownside, 4),
    remainingRiskBudget: s(r.remainingRiskBudget, 2),
  };
}

function short(a: string): string {
  return a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}

function diffKeys(a: unknown, b: unknown, prefix = ''): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) || Array.isArray(b)) return [prefix || '(root)'];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].flatMap((k) => diffKeys((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], prefix ? `${prefix}.${k}` : k));
}

function downsample<T>(xs: T[], n: number): T[] {
  if (xs.length <= n) return xs;
  const step = xs.length / n;
  const out: T[] = [];
  for (let i = 0; i < n - 1; i++) out.push(xs[Math.floor(i * step)]!);
  out.push(xs[xs.length - 1]!);
  return out;
}
