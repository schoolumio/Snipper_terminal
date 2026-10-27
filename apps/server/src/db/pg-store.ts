import type {
  Alert,
  AuditEvent,
  AuditQuery,
  BacktestRunSummary,
  Candidate,
  ChainTransaction,
  ConfigVersion,
  EngineConfig,
  EquitySnapshot,
  Ledger,
  Order,
  PersistedState,
  Position,
  PositionEvent,
  RiskAssessment,
  SizingDecision,
  Store,
  StrategySignal,
  Trade,
  TradeProposal,
  TradeQuery,
  TradingMode,
  WriteBatch,
} from '@sniper/core';
import { and, asc, desc, eq, getTableColumns, gte, inArray, lt, lte, max, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgTable } from 'drizzle-orm/pg-core';
import pg from 'pg';
import * as t from './schema';

type Db = NodePgDatabase<typeof t>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const TERMINAL = ['REJECTED', 'CLOSED', 'EXPIRED', 'FAILED', 'CANCELLED'];

/** Strip trailing zeros PostgreSQL adds to NUMERIC values ("40.000000" → "40"). */
const n = (v: string | null): string => {
  if (v === null) return '0';
  if (!v.includes('.')) return v;
  const x = v.replace(/0+$/, '').replace(/\.$/, '');
  return x === '-0' ? '0' : x;
};
const nn = (v: string | null): string | null => (v === null ? null : n(v));

function chunk<T>(xs: T[], size = 400): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

async function upsert<T extends PgTable>(tx: Tx, table: T, rows: T['$inferInsert'][], target: SQL | unknown[]): Promise<void> {
  if (!rows.length) return;
  const cols = getTableColumns(table) as Record<string, { name: string; primary: boolean }>;
  const keys = Object.keys(rows[0] as object);
  const set = Object.fromEntries(keys.map((k) => [k, sql.raw(`excluded."${cols[k]!.name}"`)]));
  for (const part of chunk(rows)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await tx.insert(table).values(part as any).onConflictDoUpdate({ target: target as any, set: set as any });
  }
}

async function insertIgnore<T extends PgTable>(tx: Tx, table: T, rows: T['$inferInsert'][]): Promise<void> {
  for (const part of chunk(rows)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (part.length) await tx.insert(table).values(part as any).onConflictDoNothing();
  }
}

export class PostgresStore implements Store {
  readonly persistent = true;
  readonly pool: pg.Pool;
  readonly db: Db;

  constructor(url: string, poolSize = 10) {
    this.pool = new pg.Pool({ connectionString: url, max: poolSize });
    this.db = drizzle(this.pool, { schema: t });
  }

  async init(): Promise<void> {
    await this.pool.query('select 1');
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query('select 1');
      return true;
    } catch {
      return false;
    }
  }

  /** Atomic unit of work. Inserts are ordered so foreign keys are satisfied. */
  async write(b: WriteBatch): Promise<void> {
    await this.db.transaction(async (tx) => {
      if (b.configs?.length) {
        await upsert(tx, t.tradingConfigurations, b.configs.map((c) => ({ version: c.version, trading: c.config.trading, changedBy: c.changedBy, changedAt: c.changedAt, note: c.note })), [t.tradingConfigurations.version]);
        await upsert(tx, t.riskConfigurations, b.configs.map((c) => ({ version: c.version, risk: c.config.risk, changedBy: c.changedBy, changedAt: c.changedAt })), [t.riskConfigurations.version]);
      }
      if (b.ledgers?.length) await upsert(tx, t.tradingAccounts, b.ledgers.map(ledgerRow), [t.tradingAccounts.mode]);
      if (b.pools?.length) {
        await upsert(tx, t.tokens, dedupe(b.pools.map((p) => ({ chain: p.chain, address: p.token.address, symbol: p.token.symbol, decimals: p.token.decimals, firstSeenAt: p.discoveredAt })), (x) => `${x.chain}:${x.address}`), [t.tokens.chain, t.tokens.address]);
        await upsert(tx, t.tokenMetadata, dedupe(b.pools.map((p) => ({ chain: p.chain, address: p.token.address, name: p.token.name, metadata: { source: p.source }, updatedAt: p.discoveredAt })), (x) => `${x.chain}:${x.address}`), [t.tokenMetadata.chain, t.tokenMetadata.address]);
        await upsert(tx, t.liquidityPools, dedupe(b.pools.map((p) => ({ chain: p.chain, address: p.address, dex: p.dex, tokenAddress: p.token.address, quoteSymbol: p.quoteSymbol, quoteAddress: p.quoteAddress, createdAt: p.createdAt, discoveredAt: p.discoveredAt, source: p.source, data: p })), (x) => `${x.chain}:${x.address}`), [t.liquidityPools.chain, t.liquidityPools.address]);
      }
      if (b.candidates?.length) await upsert(tx, t.candidates, b.candidates.map((c) => ({ id: c.id, chain: c.chain, poolAddress: c.pool.address, tokenAddress: c.pool.token.address, symbol: c.pool.token.symbol, stage: c.stage, stageReason: c.stageReason, discoveredAt: c.discoveredAt, updatedAt: c.updatedAt, data: c })), [t.candidates.id]);
      if (b.snapshots?.length) await insertIgnore(tx, t.marketSnapshots, b.snapshots.map((s) => ({ chain: s.chain, poolAddress: s.poolAddress, tokenAddress: s.tokenAddress, ts: s.ts, fetchedAt: s.fetchedAt, source: s.source, price: s.price, liquidity: s.liquidity, marketCap: s.marketCap, data: s })));
      if (b.assessments?.length) await upsert(tx, t.securityAssessments, b.assessments.map((a) => ({ id: a.id, candidateId: a.candidateId, chain: a.chain, tokenAddress: a.tokenAddress, poolAddress: a.poolAddress, ts: a.ts, phase: a.phase, verdict: a.verdict, riskScore: a.riskScore, confidence: a.confidence, summary: a.summary, factors: a.factors, configVersion: a.configVersion })), [t.securityAssessments.id]);
      if (b.signals?.length) await upsert(tx, t.strategySignals, b.signals.map((s) => ({ id: s.id, candidateId: s.candidateId, strategy: s.strategy, strategyVersion: s.strategyVersion, ts: s.ts, score: s.score, confidence: s.confidence, data: s })), [t.strategySignals.id]);
      if (b.sizing?.length) await upsert(tx, t.riskDecisions, b.sizing.map((s) => ({ id: s.id, candidateId: s.candidateId, ts: s.ts, approved: s.approved, size: s.size, maxAllowed: s.maxAllowed, data: s })), [t.riskDecisions.id]);
      if (b.proposals?.length) await upsert(tx, t.tradeProposals, b.proposals.map((p) => ({ id: p.id, candidateId: p.candidateId, mode: p.mode, tokenAddress: p.tokenAddress, strategy: p.strategy, size: p.size, status: p.status, createdAt: p.createdAt, expiresAt: p.expiresAt, data: p })), [t.tradeProposals.id]);
      if (b.positions?.length) await upsert(tx, t.positions, b.positions.map(positionRow), [t.positions.id]);
      if (b.orders?.length) await upsert(tx, t.orders, b.orders.map((o) => ({ id: o.id, idempotencyKey: o.idempotencyKey, mode: o.mode, chain: o.chain, purpose: o.purpose, side: o.side, candidateId: o.candidateId, positionId: o.positionId, tokenAddress: o.tokenAddress, amountIn: o.amountIn, status: o.status, txId: o.txId, createdAt: o.createdAt, settledAt: o.settledAt, data: o })), [t.orders.id]);
      if (b.transactions?.length) await upsert(tx, t.transactions, b.transactions.map((x) => ({ id: x.id, orderId: x.orderId, mode: x.mode, chain: x.chain, signature: x.signature, status: x.status, error: x.error, networkFeeQuote: x.networkFeeQuote, submittedAt: x.submittedAt, confirmedAt: x.confirmedAt, simulated: x.simulated, explorerUrl: x.explorerUrl })), [t.transactions.id]);
      if (b.positionEvents?.length) await insertIgnore(tx, t.positionEvents, b.positionEvents.map((e) => ({ id: e.id, positionId: e.positionId, ts: e.ts, type: e.type, detail: e.detail, data: e.data })));
      if (b.trades?.length) await upsert(tx, t.trades, b.trades.map(tradeRow), [t.trades.id]);
      if (b.equity?.length) await insertIgnore(tx, t.equitySnapshots, b.equity.map((e) => ({ ...e })));
      if (b.alerts?.length) await upsert(tx, t.alerts, b.alerts.map((a) => ({ ...a })), [t.alerts.id]);
      if (b.providerHealth?.length) await upsert(tx, t.providerHealth, b.providerHealth.map((h) => ({ ...h })), [t.providerHealth.provider]);
      if (b.kv?.length) await upsert(tx, t.kvState, b.kv.map((k) => ({ key: k.key, value: k.value, updatedAt: Date.now() })), [t.kvState.key]);
      // Audit last, append-only.
      if (b.audit?.length) for (const part of chunk(b.audit)) await tx.insert(t.auditLog).values(part.map(auditRow));
    });
  }

  async load(): Promise<PersistedState> {
    const db = this.db;
    const [cfgRow] = await db.select().from(t.tradingConfigurations).orderBy(desc(t.tradingConfigurations.version)).limit(1);
    let config: ConfigVersion | null = null;
    if (cfgRow) {
      const [risk] = await db.select().from(t.riskConfigurations).where(eq(t.riskConfigurations.version, cfgRow.version));
      if (risk) config = { version: cfgRow.version, config: { trading: cfgRow.trading, risk: risk.risk } as EngineConfig, changedBy: cfgRow.changedBy, changedAt: cfgRow.changedAt, note: cfgRow.note };
    }
    const ledgers = (await db.select().from(t.tradingAccounts)).map(ledgerFrom);
    const openPositions = (await db.select({ data: t.positions.data }).from(t.positions).where(notInArray(t.positions.status, ['closed', 'failed']))).map((r) => r.data as Position);
    const recentPositions = (await db.select({ data: t.positions.data }).from(t.positions).where(eq(t.positions.status, 'closed')).orderBy(desc(t.positions.closedAt)).limit(50)).map((r) => r.data as Position);
    const pendingOrders = (await db.select({ data: t.orders.data }).from(t.orders).where(inArray(t.orders.status, ['created', 'submitted', 'unknown']))).map((r) => r.data as Order);
    const activeCandidates = (await db.select({ data: t.candidates.data }).from(t.candidates).where(notInArray(t.candidates.stage, TERMINAL))).map((r) => r.data as Candidate);
    const recentTrades = (await db.select().from(t.trades).orderBy(asc(t.trades.exitAt)).limit(20_000)).map(tradeFrom);
    const recentAudit = (await db.select().from(t.auditLog).orderBy(desc(t.auditLog.seq)).limit(500)).map(auditFrom).reverse();
    const recentAlerts = (await db.select().from(t.alerts).orderBy(desc(t.alerts.ts)).limit(100)).map((a) => a as Alert);
    const equity: EquitySnapshot[] = [];
    for (const mode of ['paper', 'live'] as const) {
      const rows = await db.select().from(t.equitySnapshots).where(eq(t.equitySnapshots.mode, mode)).orderBy(desc(t.equitySnapshots.ts)).limit(3000);
      equity.push(...rows.reverse().map(equityFrom));
    }
    const [seqRow] = await db.select({ m: max(t.auditLog.seq) }).from(t.auditLog);
    const kv = Object.fromEntries((await db.select().from(t.kvState)).map((r) => [r.key, r.value]));
    const [txc] = await db
      .select({ total: sql<number>`count(*)::int`, failed: sql<number>`count(*) filter (where ${t.transactions.status} = 'failed')::int` })
      .from(t.transactions)
      .where(eq(t.transactions.mode, 'paper'));
    return {
      config,
      ledgers,
      openPositions,
      recentPositions,
      pendingOrders,
      activeCandidates,
      recentTrades,
      recentAudit,
      recentAlerts,
      equity,
      lastAuditSeq: Number(seqRow?.m ?? 0),
      kv,
      counters: { txSubmitted: txc?.total ?? 0, txFailed: txc?.failed ?? 0 },
    };
  }

  async listTrades(q: TradeQuery): Promise<{ rows: Trade[]; total: number }> {
    const conds: SQL[] = [];
    if (q.mode) conds.push(eq(t.trades.mode, q.mode));
    if (q.symbol) conds.push(or(sql`${t.trades.symbol} ilike ${'%' + q.symbol.replace(/[%_]/g, '') + '%'}`, eq(t.trades.tokenAddress, q.symbol))!);
    if (q.strategy) conds.push(eq(t.trades.strategy, q.strategy));
    if (q.exitReason) conds.push(eq(t.trades.exitReason, q.exitReason));
    if (q.from) conds.push(gte(t.trades.exitAt, q.from));
    if (q.to) conds.push(lte(t.trades.exitAt, q.to));
    const where = conds.length ? and(...conds) : undefined;
    const rows = await this.db.select().from(t.trades).where(where).orderBy(desc(t.trades.exitAt)).limit(q.limit ?? 100).offset(q.offset ?? 0);
    const [c] = await this.db.select({ n: sql<number>`count(*)::int` }).from(t.trades).where(where);
    return { rows: rows.map(tradeFrom), total: c?.n ?? 0 };
  }

  async listAudit(q: AuditQuery): Promise<AuditEvent[]> {
    const conds: SQL[] = [];
    if (q.agent) conds.push(eq(t.auditLog.agent, q.agent));
    if (q.result) conds.push(eq(t.auditLog.result, q.result));
    if (q.correlationId) conds.push(eq(t.auditLog.correlationId, q.correlationId));
    if (q.positionId) conds.push(eq(t.auditLog.positionId, q.positionId));
    if (q.mode) conds.push(eq(t.auditLog.mode, q.mode));
    if (q.from) conds.push(gte(t.auditLog.ts, q.from));
    if (q.to) conds.push(lte(t.auditLog.ts, q.to));
    if (q.beforeSeq) conds.push(lt(t.auditLog.seq, q.beforeSeq));
    if (q.search) {
      conds.push(
        or(
          sql`to_tsvector('simple', ${t.auditLog.action} || ' ' || ${t.auditLog.reason} || ' ' || coalesce(${t.auditLog.symbol}, '')) @@ plainto_tsquery('simple', ${q.search})`,
          eq(t.auditLog.tokenAddress, q.search),
          eq(t.auditLog.symbol, q.search.toUpperCase().replace(/^\$/, '')),
        )!,
      );
    }
    const rows = await this.db.select().from(t.auditLog).where(conds.length ? and(...conds) : undefined).orderBy(desc(t.auditLog.seq)).limit(Math.min(q.limit ?? 200, 5000));
    return rows.map(auditFrom);
  }

  async listEquity(mode: TradingMode, since: number, limit: number): Promise<EquitySnapshot[]> {
    const rows = await this.db.select().from(t.equitySnapshots).where(and(eq(t.equitySnapshots.mode, mode), gte(t.equitySnapshots.ts, since))).orderBy(desc(t.equitySnapshots.ts)).limit(limit);
    return rows.reverse().map(equityFrom);
  }

  async listConfigVersions(limit: number): Promise<ConfigVersion[]> {
    const rows = await this.db
      .select()
      .from(t.tradingConfigurations)
      .innerJoin(t.riskConfigurations, eq(t.tradingConfigurations.version, t.riskConfigurations.version))
      .orderBy(desc(t.tradingConfigurations.version))
      .limit(limit);
    return rows.map((r) => ({ version: r.trading_configurations.version, config: { trading: r.trading_configurations.trading, risk: r.risk_configurations.risk } as EngineConfig, changedBy: r.trading_configurations.changedBy, changedAt: r.trading_configurations.changedAt, note: r.trading_configurations.note }));
  }

  async getPosition(id: string): Promise<Position | null> {
    const [r] = await this.db.select({ data: t.positions.data }).from(t.positions).where(eq(t.positions.id, id));
    return (r?.data as Position) ?? null;
  }

  async getPositionEvents(positionId: string): Promise<PositionEvent[]> {
    const rows = await this.db.select().from(t.positionEvents).where(eq(t.positionEvents.positionId, positionId)).orderBy(asc(t.positionEvents.ts));
    return rows.map((r) => ({ id: r.id, positionId: r.positionId, ts: r.ts, type: r.type as PositionEvent['type'], detail: r.detail, data: r.data as PositionEvent['data'] }));
  }

  async getOrders(f: { positionId?: string; candidateId?: string }): Promise<Order[]> {
    const conds: SQL[] = [];
    if (f.positionId) conds.push(eq(t.orders.positionId, f.positionId));
    if (f.candidateId) conds.push(eq(t.orders.candidateId, f.candidateId));
    if (!conds.length) return [];
    const rows = await this.db.select({ data: t.orders.data }).from(t.orders).where(or(...conds)).orderBy(asc(t.orders.createdAt));
    return rows.map((r) => r.data as Order);
  }

  async getTransactions(orderIds: string[]): Promise<ChainTransaction[]> {
    if (!orderIds.length) return [];
    const rows = await this.db.select().from(t.transactions).where(inArray(t.transactions.orderId, orderIds));
    return rows.map((r) => ({ ...r, mode: r.mode as TradingMode, chain: r.chain as ChainTransaction['chain'], status: r.status as ChainTransaction['status'], networkFeeQuote: nn(r.networkFeeQuote) }));
  }

  async getCandidate(id: string): Promise<Candidate | null> {
    const [r] = await this.db.select({ data: t.candidates.data }).from(t.candidates).where(eq(t.candidates.id, id));
    return (r?.data as Candidate) ?? null;
  }

  async getAssessments(candidateId: string): Promise<RiskAssessment[]> {
    const rows = await this.db.select().from(t.securityAssessments).where(eq(t.securityAssessments.candidateId, candidateId)).orderBy(asc(t.securityAssessments.ts));
    return rows.map((r) => ({ ...r, chain: r.chain as RiskAssessment['chain'], phase: r.phase as RiskAssessment['phase'], factors: r.factors as RiskAssessment['factors'] }));
  }

  async getSignals(candidateId: string): Promise<StrategySignal[]> {
    return (await this.db.select({ data: t.strategySignals.data }).from(t.strategySignals).where(eq(t.strategySignals.candidateId, candidateId)).orderBy(asc(t.strategySignals.ts))).map((r) => r.data as StrategySignal);
  }

  async getProposals(candidateId: string): Promise<TradeProposal[]> {
    return (await this.db.select({ data: t.tradeProposals.data }).from(t.tradeProposals).where(eq(t.tradeProposals.candidateId, candidateId)).orderBy(asc(t.tradeProposals.createdAt))).map((r) => r.data as TradeProposal);
  }

  async getSizing(candidateId: string): Promise<SizingDecision[]> {
    return (await this.db.select({ data: t.riskDecisions.data }).from(t.riskDecisions).where(eq(t.riskDecisions.candidateId, candidateId)).orderBy(asc(t.riskDecisions.ts))).map((r) => r.data as SizingDecision);
  }

  async listAlerts(limit: number): Promise<Alert[]> {
    return (await this.db.select().from(t.alerts).orderBy(desc(t.alerts.ts)).limit(limit)).map((a) => a as Alert);
  }

  async saveBacktest(run: BacktestRunSummary, trades: Trade[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await upsert(tx, t.backtestRuns, [{ id: run.id, createdAt: run.createdAt, status: run.status, dataSource: run.dataSource, seed: run.seed, durationSec: run.durationSec, configVersion: run.configVersion, stats: run.stats, equityCurve: run.equityCurve, error: run.error, notes: run.notes }], [t.backtestRuns.id]);
      await insertIgnore(tx, t.backtestTrades, trades.map((x) => ({ id: `${run.id}:${x.id}`, runId: run.id, symbol: x.symbol, strategy: x.strategy, netPnl: x.netPnl, exitAt: x.exitAt, data: x })));
    });
  }

  async listBacktests(limit: number): Promise<BacktestRunSummary[]> {
    const rows = await this.db.select().from(t.backtestRuns).orderBy(desc(t.backtestRuns.createdAt)).limit(limit);
    return rows.map(backtestFrom);
  }

  async getBacktest(id: string): Promise<{ run: BacktestRunSummary; trades: Trade[] } | null> {
    const [r] = await this.db.select().from(t.backtestRuns).where(eq(t.backtestRuns.id, id));
    if (!r) return null;
    const trades = await this.db.select({ data: t.backtestTrades.data }).from(t.backtestTrades).where(eq(t.backtestTrades.runId, id)).orderBy(asc(t.backtestTrades.exitAt));
    return { run: backtestFrom(r), trades: trades.map((x) => x.data as Trade) };
  }

  async pruneSnapshots(before: number): Promise<number> {
    const res = await this.db.delete(t.marketSnapshots).where(lt(t.marketSnapshots.fetchedAt, before));
    return res.rowCount ?? 0;
  }
}

function dedupe<T>(xs: T[], key: (x: T) => string): T[] {
  return [...new Map(xs.map((x) => [key(x), x])).values()];
}

const ledgerRow = (l: Ledger) => ({ ...l });
function ledgerFrom(r: typeof t.tradingAccounts.$inferSelect): Ledger {
  return {
    mode: r.mode,
    currency: r.currency,
    startingEquity: n(r.startingEquity),
    cash: n(r.cash),
    reserved: n(r.reserved),
    deposits: n(r.deposits),
    withdrawals: n(r.withdrawals),
    realizedPnl: n(r.realizedPnl),
    feesPaid: n(r.feesPaid),
    peakEquity: n(r.peakEquity),
    dayStartEquity: n(r.dayStartEquity),
    dayKey: r.dayKey,
    updatedAt: r.updatedAt,
  };
}

const positionRow = (p: Position) => ({ id: p.id, mode: p.mode, chain: p.chain, candidateId: p.candidateId, tokenAddress: p.tokenAddress, poolAddress: p.poolAddress, symbol: p.symbol, strategy: p.strategy, status: p.status, costBasis: p.costBasis, realizedPnl: p.realizedPnl, openedAt: p.openedAt, closedAt: p.closedAt, data: p });

const tradeRow = (x: Trade) => ({ ...x });
function tradeFrom(r: typeof t.trades.$inferSelect): Trade {
  return {
    ...r,
    mode: r.mode as TradingMode,
    chain: r.chain as Trade['chain'],
    strategy: r.strategy as Trade['strategy'],
    txStatus: r.txStatus as Trade['txStatus'],
    entryPrice: n(r.entryPrice),
    exitPrice: n(r.exitPrice),
    size: n(r.size),
    qty: n(r.qty),
    grossPnl: n(r.grossPnl),
    fees: n(r.fees),
    netPnl: n(r.netPnl),
    returnPct: n(r.returnPct),
    slippagePct: n(r.slippagePct),
  };
}

const auditRow = (e: AuditEvent) => ({ ...e });
function auditFrom(r: typeof t.auditLog.$inferSelect): AuditEvent {
  return { ...r, agent: r.agent as AuditEvent['agent'], result: r.result as AuditEvent['result'], mode: r.mode as TradingMode, sizeQuote: nn(r.sizeQuote), metrics: r.metrics as AuditEvent['metrics'] };
}

function equityFrom(r: typeof t.equitySnapshots.$inferSelect): EquitySnapshot {
  return {
    ...r,
    mode: r.mode as TradingMode,
    equity: n(r.equity),
    cash: n(r.cash),
    reserved: n(r.reserved),
    openLiquidationValue: n(r.openLiquidationValue),
    openMarkValue: n(r.openMarkValue),
    realizedPnl: n(r.realizedPnl),
    unrealizedPnl: n(r.unrealizedPnl),
    drawdownPct: n(r.drawdownPct),
  };
}

function backtestFrom(r: typeof t.backtestRuns.$inferSelect): BacktestRunSummary {
  return { ...r, status: r.status as BacktestRunSummary['status'], stats: r.stats as BacktestRunSummary['stats'], equityCurve: r.equityCurve as BacktestRunSummary['equityCurve'] };
}
