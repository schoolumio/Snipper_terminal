import { isTerminal } from '../state-machine';
import type {
  Alert,
  AuditEvent,
  BacktestRunSummary,
  Candidate,
  ChainTransaction,
  EquitySnapshot,
  Ledger,
  MarketSnapshot,
  Order,
  Position,
  PositionEvent,
  RiskAssessment,
  SizingDecision,
  StrategySignal,
  Trade,
  TradeProposal,
  TradingMode,
} from '../types';
import type { AuditQuery, ConfigVersion, PersistedState, Store, TradeQuery, WriteBatch } from './store';

const clone = <T>(x: T): T => structuredClone(x);

/** Non-persistent store for tests, backtests and running without a database. */
export class MemoryStore implements Store {
  readonly persistent = false;
  candidates = new Map<string, Candidate>();
  snapshots: MarketSnapshot[] = [];
  assessments = new Map<string, RiskAssessment>();
  signals = new Map<string, StrategySignal>();
  proposals = new Map<string, TradeProposal>();
  sizing = new Map<string, SizingDecision>();
  orders = new Map<string, Order>();
  transactions = new Map<string, ChainTransaction>();
  positions = new Map<string, Position>();
  positionEvents: PositionEvent[] = [];
  trades = new Map<string, Trade>();
  audit: AuditEvent[] = [];
  equity: EquitySnapshot[] = [];
  alerts = new Map<string, Alert>();
  ledgers = new Map<TradingMode, Ledger>();
  configs: ConfigVersion[] = [];
  kv = new Map<string, string>();
  backtests = new Map<string, { run: BacktestRunSummary; trades: Trade[] }>();
  /** Maximum retained rows for append-only collections. */
  constructor(private readonly cap = 50_000) {}

  async init(): Promise<void> {}
  async close(): Promise<void> {}

  async write(b: WriteBatch): Promise<void> {
    const up = <T extends { id: string }>(m: Map<string, T>, xs?: T[]) => xs?.forEach((x) => m.set(x.id, clone(x)));
    up(this.candidates, b.candidates);
    up(this.assessments, b.assessments);
    up(this.signals, b.signals);
    up(this.proposals, b.proposals);
    up(this.sizing, b.sizing);
    up(this.orders, b.orders);
    up(this.transactions, b.transactions);
    up(this.positions, b.positions);
    up(this.trades, b.trades);
    up(this.alerts, b.alerts);
    if (b.snapshots) this.snapshots.push(...b.snapshots.map(clone));
    if (b.positionEvents) this.positionEvents.push(...b.positionEvents.map(clone));
    if (b.audit) this.audit.push(...b.audit.map(clone));
    if (b.equity) this.equity.push(...b.equity.map(clone));
    b.ledgers?.forEach((l) => this.ledgers.set(l.mode, clone(l)));
    if (b.configs) this.configs.push(...b.configs.map(clone));
    b.kv?.forEach((x) => this.kv.set(x.key, x.value));
    for (const arr of [this.snapshots, this.positionEvents, this.audit, this.equity] as unknown[][]) {
      if (arr.length > this.cap) arr.splice(0, arr.length - this.cap);
    }
  }

  async load(): Promise<PersistedState> {
    const positions = [...this.positions.values()];
    const orders = [...this.orders.values()];
    const tx = [...this.transactions.values()];
    return clone({
      config: this.configs[this.configs.length - 1] ?? null,
      ledgers: [...this.ledgers.values()],
      openPositions: positions.filter((p) => p.status !== 'closed' && p.status !== 'failed'),
      recentPositions: positions.filter((p) => p.status === 'closed').slice(-50),
      pendingOrders: orders.filter((o) => o.status === 'created' || o.status === 'submitted' || o.status === 'unknown'),
      activeCandidates: [...this.candidates.values()].filter((c) => !isTerminal(c.stage)),
      recentTrades: [...this.trades.values()].sort((a, b) => b.exitAt - a.exitAt).slice(0, 200),
      recentAudit: this.audit.slice(-500),
      recentAlerts: [...this.alerts.values()].slice(-100),
      equity: this.equity.slice(-2000),
      lastAuditSeq: this.audit.reduce((m, e) => Math.max(m, e.seq), 0),
      kv: Object.fromEntries(this.kv),
      counters: { txSubmitted: tx.length, txFailed: tx.filter((t) => t.status === 'failed').length },
    });
  }

  async listTrades(q: TradeQuery): Promise<{ rows: Trade[]; total: number }> {
    let rows = [...this.trades.values()];
    if (q.mode) rows = rows.filter((t) => t.mode === q.mode);
    if (q.symbol) rows = rows.filter((t) => t.symbol.toLowerCase().includes(q.symbol!.toLowerCase()) || t.tokenAddress === q.symbol);
    if (q.strategy) rows = rows.filter((t) => t.strategy === q.strategy);
    if (q.exitReason) rows = rows.filter((t) => t.exitReason === q.exitReason);
    if (q.from) rows = rows.filter((t) => t.exitAt >= q.from!);
    if (q.to) rows = rows.filter((t) => t.exitAt <= q.to!);
    rows.sort((a, b) => b.exitAt - a.exitAt);
    const off = q.offset ?? 0;
    return { rows: clone(rows.slice(off, off + (q.limit ?? 100))), total: rows.length };
  }

  async listAudit(q: AuditQuery): Promise<AuditEvent[]> {
    let rows = this.audit;
    if (q.agent) rows = rows.filter((e) => e.agent === q.agent);
    if (q.result) rows = rows.filter((e) => e.result === q.result);
    if (q.correlationId) rows = rows.filter((e) => e.correlationId === q.correlationId);
    if (q.positionId) rows = rows.filter((e) => e.positionId === q.positionId);
    if (q.mode) rows = rows.filter((e) => e.mode === q.mode);
    if (q.from) rows = rows.filter((e) => e.ts >= q.from!);
    if (q.to) rows = rows.filter((e) => e.ts <= q.to!);
    if (q.beforeSeq) rows = rows.filter((e) => e.seq < q.beforeSeq!);
    if (q.search) {
      const s = q.search.toLowerCase();
      rows = rows.filter((e) => `${e.action} ${e.reason} ${e.symbol ?? ''} ${e.tokenAddress ?? ''}`.toLowerCase().includes(s));
    }
    return clone(rows.slice(-(q.limit ?? 200)).reverse());
  }

  async listEquity(mode: TradingMode, since: number, limit: number): Promise<EquitySnapshot[]> {
    return clone(this.equity.filter((e) => e.mode === mode && e.ts >= since).slice(-limit));
  }

  async listConfigVersions(limit: number): Promise<ConfigVersion[]> {
    return clone(this.configs.slice(-limit).reverse());
  }

  async getPosition(id: string) {
    const p = this.positions.get(id);
    return p ? clone(p) : null;
  }
  async getPositionEvents(positionId: string) {
    return clone(this.positionEvents.filter((e) => e.positionId === positionId));
  }
  async getOrders(f: { positionId?: string; candidateId?: string }) {
    return clone([...this.orders.values()].filter((o) => (f.positionId ? o.positionId === f.positionId : true) && (f.candidateId ? o.candidateId === f.candidateId : true)));
  }
  async getTransactions(orderIds: string[]) {
    const s = new Set(orderIds);
    return clone([...this.transactions.values()].filter((t) => s.has(t.orderId)));
  }
  async getCandidate(id: string) {
    const c = this.candidates.get(id);
    return c ? clone(c) : null;
  }
  async getAssessments(candidateId: string) {
    return clone([...this.assessments.values()].filter((a) => a.candidateId === candidateId));
  }
  async getSignals(candidateId: string) {
    return clone([...this.signals.values()].filter((a) => a.candidateId === candidateId));
  }
  async getProposals(candidateId: string) {
    return clone([...this.proposals.values()].filter((a) => a.candidateId === candidateId));
  }
  async getSizing(candidateId: string) {
    return clone([...this.sizing.values()].filter((a) => a.candidateId === candidateId));
  }
  async listAlerts(limit: number) {
    return clone([...this.alerts.values()].sort((a, b) => b.ts - a.ts).slice(0, limit));
  }
  async saveBacktest(run: BacktestRunSummary, trades: Trade[]) {
    this.backtests.set(run.id, clone({ run, trades }));
  }
  async listBacktests(limit: number) {
    return clone([...this.backtests.values()].map((b) => b.run).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit));
  }
  async getBacktest(id: string) {
    const b = this.backtests.get(id);
    return b ? clone(b) : null;
  }
  async pruneSnapshots(before: number) {
    const n = this.snapshots.length;
    this.snapshots = this.snapshots.filter((x) => x.fetchedAt >= before);
    return n - this.snapshots.length;
  }
}
