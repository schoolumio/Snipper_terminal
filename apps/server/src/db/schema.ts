import { sql } from 'drizzle-orm';
import { bigint, boolean, index, integer, jsonb, numeric, pgTable, primaryKey, real, text, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * PostgreSQL schema. Money and quantities are NUMERIC(38,18); timestamps are
 * epoch milliseconds (BIGINT). Assets are always keyed by (chain, address),
 * never by symbol. Rich nested objects are kept in JSONB `data` columns next
 * to the indexed, queryable columns so records round-trip exactly.
 */

const ts = (name: string) => bigint(name, { mode: 'number' });
const money = (name: string) => numeric(name, { precision: 38, scale: 18 });

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: ['admin', 'viewer'] }).notNull(),
  createdAt: ts('created_at').notNull(),
  disabled: boolean('disabled').notNull().default(false),
});

/** One ledger per trading mode (paper / live). */
export const tradingAccounts = pgTable('trading_accounts', {
  mode: text('mode', { enum: ['paper', 'live'] }).primaryKey(),
  currency: text('currency').notNull(),
  startingEquity: money('starting_equity').notNull(),
  cash: money('cash').notNull(),
  reserved: money('reserved').notNull(),
  deposits: money('deposits').notNull(),
  withdrawals: money('withdrawals').notNull(),
  realizedPnl: money('realized_pnl').notNull(),
  feesPaid: money('fees_paid').notNull(),
  peakEquity: money('peak_equity').notNull(),
  dayStartEquity: money('day_start_equity').notNull(),
  dayKey: text('day_key').notNull(),
  updatedAt: ts('updated_at').notNull(),
});

export const wallets = pgTable(
  'wallets',
  {
    id: text('id').primaryKey(),
    chain: text('chain').notNull(),
    address: text('address').notNull(),
    label: text('label').notNull(),
    mode: text('mode', { enum: ['paper', 'live'] }).notNull(),
    allowed: boolean('allowed').notNull().default(false),
    spendLimitQuote: money('spend_limit_quote'),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [uniqueIndex('wallets_chain_address').on(t.chain, t.address)],
);

export const tradingConfigurations = pgTable('trading_configurations', {
  version: integer('version').primaryKey(),
  trading: jsonb('trading').notNull(),
  changedBy: text('changed_by').notNull(),
  changedAt: ts('changed_at').notNull(),
  note: text('note').notNull().default(''),
});

export const riskConfigurations = pgTable('risk_configurations', {
  version: integer('version').primaryKey(),
  risk: jsonb('risk').notNull(),
  changedBy: text('changed_by').notNull(),
  changedAt: ts('changed_at').notNull(),
});

export const agents = pgTable('agents', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  role: text('role').notNull(),
  enabled: boolean('enabled').notNull().default(true),
});

export const tokens = pgTable(
  'tokens',
  {
    chain: text('chain').notNull(),
    address: text('address').notNull(),
    symbol: text('symbol').notNull(),
    decimals: integer('decimals').notNull(),
    firstSeenAt: ts('first_seen_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.chain, t.address] }), index('tokens_symbol').on(t.symbol)],
);

export const tokenMetadata = pgTable(
  'token_metadata',
  {
    chain: text('chain').notNull(),
    address: text('address').notNull(),
    name: text('name').notNull(),
    metadata: jsonb('metadata').notNull().default({}),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.chain, t.address] })],
);

export const liquidityPools = pgTable(
  'liquidity_pools',
  {
    chain: text('chain').notNull(),
    address: text('address').notNull(),
    dex: text('dex').notNull(),
    tokenAddress: text('token_address').notNull(),
    quoteSymbol: text('quote_symbol').notNull(),
    quoteAddress: text('quote_address').notNull(),
    createdAt: ts('created_at').notNull(),
    discoveredAt: ts('discovered_at').notNull(),
    source: text('source').notNull(),
    data: jsonb('data').notNull(),
  },
  (t) => [primaryKey({ columns: [t.chain, t.address] }), index('pools_token').on(t.chain, t.tokenAddress)],
);

export const marketSnapshots = pgTable(
  'market_snapshots',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    chain: text('chain').notNull(),
    poolAddress: text('pool_address').notNull(),
    tokenAddress: text('token_address').notNull(),
    ts: ts('ts').notNull(),
    fetchedAt: ts('fetched_at').notNull(),
    source: text('source').notNull(),
    price: money('price').notNull(),
    liquidity: money('liquidity').notNull(),
    marketCap: money('market_cap'),
    data: jsonb('data').notNull(),
  },
  (t) => [index('snapshots_pool_ts').on(t.chain, t.poolAddress, t.ts), index('snapshots_fetched').on(t.fetchedAt)],
);

export const candidates = pgTable(
  'candidates',
  {
    id: text('id').primaryKey(),
    chain: text('chain').notNull(),
    poolAddress: text('pool_address').notNull(),
    tokenAddress: text('token_address').notNull(),
    symbol: text('symbol').notNull(),
    stage: text('stage').notNull(),
    stageReason: text('stage_reason'),
    discoveredAt: ts('discovered_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
    data: jsonb('data').notNull(),
  },
  (t) => [index('candidates_stage').on(t.stage), index('candidates_token').on(t.chain, t.tokenAddress), index('candidates_updated').on(t.updatedAt)],
);

export const securityAssessments = pgTable(
  'security_assessments',
  {
    id: text('id').primaryKey(),
    candidateId: text('candidate_id').notNull(),
    chain: text('chain').notNull(),
    tokenAddress: text('token_address').notNull(),
    poolAddress: text('pool_address').notNull(),
    ts: ts('ts').notNull(),
    phase: text('phase').notNull(),
    verdict: text('verdict', { enum: ['PASS', 'REVIEW', 'REJECT'] }).notNull(),
    riskScore: integer('risk_score').notNull(),
    confidence: real('confidence').notNull(),
    summary: text('summary').notNull(),
    factors: jsonb('factors').notNull(),
    configVersion: integer('config_version').notNull(),
  },
  (t) => [index('assessments_candidate').on(t.candidateId), index('assessments_token').on(t.chain, t.tokenAddress)],
);

export const strategies = pgTable(
  'strategies',
  {
    id: text('id').notNull(),
    version: text('version').notNull(),
    label: text('label').notNull(),
    registeredAt: ts('registered_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.id, t.version] })],
);

export const strategySignals = pgTable(
  'strategy_signals',
  {
    id: text('id').primaryKey(),
    candidateId: text('candidate_id').notNull(),
    strategy: text('strategy').notNull(),
    strategyVersion: text('strategy_version').notNull(),
    ts: ts('ts').notNull(),
    score: real('score').notNull(),
    confidence: real('confidence').notNull(),
    data: jsonb('data').notNull(),
  },
  (t) => [index('signals_candidate').on(t.candidateId)],
);

export const tradeProposals = pgTable(
  'trade_proposals',
  {
    id: text('id').primaryKey(),
    candidateId: text('candidate_id').notNull(),
    mode: text('mode').notNull(),
    tokenAddress: text('token_address').notNull(),
    strategy: text('strategy').notNull(),
    size: money('size').notNull(),
    status: text('status').notNull(),
    createdAt: ts('created_at').notNull(),
    expiresAt: ts('expires_at').notNull(),
    data: jsonb('data').notNull(),
  },
  (t) => [index('proposals_candidate').on(t.candidateId), index('proposals_status').on(t.status)],
);

/** Sizer / portfolio-risk decisions. */
export const riskDecisions = pgTable(
  'risk_decisions',
  {
    id: text('id').primaryKey(),
    candidateId: text('candidate_id').notNull(),
    ts: ts('ts').notNull(),
    approved: boolean('approved').notNull(),
    size: money('size').notNull(),
    maxAllowed: money('max_allowed').notNull(),
    data: jsonb('data').notNull(),
  },
  (t) => [index('risk_decisions_candidate').on(t.candidateId)],
);

export const orders = pgTable(
  'orders',
  {
    id: text('id').primaryKey(),
    idempotencyKey: text('idempotency_key').notNull(),
    mode: text('mode').notNull(),
    chain: text('chain').notNull(),
    purpose: text('purpose').notNull(),
    side: text('side').notNull(),
    candidateId: text('candidate_id').notNull(),
    positionId: text('position_id'),
    tokenAddress: text('token_address').notNull(),
    amountIn: money('amount_in').notNull(),
    status: text('status').notNull(),
    txId: text('tx_id'),
    createdAt: ts('created_at').notNull(),
    settledAt: ts('settled_at'),
    data: jsonb('data').notNull(),
  },
  (t) => [uniqueIndex('orders_idempotency').on(t.idempotencyKey), index('orders_status').on(t.status), index('orders_position').on(t.positionId), index('orders_candidate').on(t.candidateId)],
);

export const transactions = pgTable(
  'transactions',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id),
    mode: text('mode').notNull(),
    chain: text('chain').notNull(),
    signature: text('signature').notNull(),
    status: text('status').notNull(),
    error: text('error'),
    networkFeeQuote: money('network_fee_quote'),
    submittedAt: ts('submitted_at').notNull(),
    confirmedAt: ts('confirmed_at'),
    simulated: boolean('simulated').notNull(),
    explorerUrl: text('explorer_url'),
  },
  (t) => [uniqueIndex('transactions_signature').on(t.chain, t.signature), index('transactions_order').on(t.orderId)],
);

export const positions = pgTable(
  'positions',
  {
    id: text('id').primaryKey(),
    mode: text('mode').notNull(),
    chain: text('chain').notNull(),
    candidateId: text('candidate_id').notNull(),
    tokenAddress: text('token_address').notNull(),
    poolAddress: text('pool_address').notNull(),
    symbol: text('symbol').notNull(),
    strategy: text('strategy').notNull(),
    status: text('status').notNull(),
    costBasis: money('cost_basis').notNull(),
    realizedPnl: money('realized_pnl').notNull(),
    openedAt: ts('opened_at').notNull(),
    closedAt: ts('closed_at'),
    data: jsonb('data').notNull(),
  },
  (t) => [index('positions_status').on(t.mode, t.status), index('positions_token').on(t.chain, t.tokenAddress)],
);

export const positionEvents = pgTable(
  'position_events',
  {
    id: text('id').primaryKey(),
    positionId: text('position_id')
      .notNull()
      .references(() => positions.id),
    ts: ts('ts').notNull(),
    type: text('type').notNull(),
    detail: text('detail').notNull(),
    data: jsonb('data').notNull(),
  },
  (t) => [index('position_events_position').on(t.positionId, t.ts)],
);

export const trades = pgTable(
  'trades',
  {
    id: text('id').primaryKey(),
    positionId: text('position_id')
      .notNull()
      .references(() => positions.id),
    mode: text('mode').notNull(),
    chain: text('chain').notNull(),
    tokenAddress: text('token_address').notNull(),
    poolAddress: text('pool_address').notNull(),
    symbol: text('symbol').notNull(),
    strategy: text('strategy').notNull(),
    candidateId: text('candidate_id').notNull(),
    entryAt: ts('entry_at').notNull(),
    exitAt: ts('exit_at').notNull(),
    entryPrice: money('entry_price').notNull(),
    exitPrice: money('exit_price').notNull(),
    size: money('size').notNull(),
    qty: money('qty').notNull(),
    grossPnl: money('gross_pnl').notNull(),
    fees: money('fees').notNull(),
    netPnl: money('net_pnl').notNull(),
    returnPct: money('return_pct').notNull(),
    holdSec: integer('hold_sec').notNull(),
    exitReason: text('exit_reason').notNull(),
    txStatus: text('tx_status').notNull(),
    slippagePct: money('slippage_pct').notNull(),
  },
  (t) => [uniqueIndex('trades_position').on(t.positionId), index('trades_mode_exit').on(t.mode, t.exitAt), index('trades_symbol').on(t.symbol)],
);

export const equitySnapshots = pgTable(
  'equity_snapshots',
  {
    id: text('id').primaryKey(),
    mode: text('mode').notNull(),
    ts: ts('ts').notNull(),
    equity: money('equity').notNull(),
    cash: money('cash').notNull(),
    reserved: money('reserved').notNull(),
    openLiquidationValue: money('open_liquidation_value').notNull(),
    openMarkValue: money('open_mark_value').notNull(),
    realizedPnl: money('realized_pnl').notNull(),
    unrealizedPnl: money('unrealized_pnl').notNull(),
    drawdownPct: money('drawdown_pct').notNull(),
    openPositions: integer('open_positions').notNull(),
    unvaluedPositions: integer('unvalued_positions').notNull(),
  },
  (t) => [index('equity_mode_ts').on(t.mode, t.ts)],
);

/** Append-only. UPDATE / DELETE are blocked by a trigger (see migrations). */
export const auditLog = pgTable(
  'audit_log',
  {
    seq: bigint('seq', { mode: 'number' }).primaryKey(),
    id: text('id').notNull().unique(),
    ts: ts('ts').notNull(),
    correlationId: text('correlation_id'),
    agent: text('agent').notNull(),
    action: text('action').notNull(),
    result: text('result').notNull(),
    mode: text('mode').notNull(),
    tokenAddress: text('token_address'),
    symbol: text('symbol'),
    positionId: text('position_id'),
    sizeQuote: money('size_quote'),
    reason: text('reason').notNull(),
    metrics: jsonb('metrics').notNull(),
    configVersion: integer('config_version').notNull(),
    strategyVersion: text('strategy_version'),
  },
  (t) => [
    index('audit_ts').on(t.ts),
    index('audit_correlation').on(t.correlationId),
    index('audit_agent').on(t.agent, t.seq),
    index('audit_position').on(t.positionId),
    index('audit_search').using('gin', sql`to_tsvector('simple', ${t.action} || ' ' || ${t.reason} || ' ' || coalesce(${t.symbol}, ''))`),
  ],
);

export const alerts = pgTable(
  'alerts',
  {
    id: text('id').primaryKey(),
    ts: ts('ts').notNull(),
    level: text('level').notNull(),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    message: text('message').notNull(),
    mode: text('mode').notNull(),
    acknowledged: boolean('acknowledged').notNull(),
    correlationId: text('correlation_id'),
  },
  (t) => [index('alerts_ts').on(t.ts)],
);

export const providerHealth = pgTable('provider_health', {
  provider: text('provider').primaryKey(),
  kind: text('kind').notNull(),
  ok: boolean('ok').notNull(),
  lastSuccessAt: ts('last_success_at'),
  lastErrorAt: ts('last_error_at'),
  lastError: text('last_error'),
  consecutiveFailures: integer('consecutive_failures').notNull(),
  latencyMs: integer('latency_ms'),
});

export const backtestRuns = pgTable('backtest_runs', {
  id: text('id').primaryKey(),
  createdAt: ts('created_at').notNull(),
  status: text('status').notNull(),
  dataSource: text('data_source').notNull(),
  seed: integer('seed').notNull(),
  durationSec: integer('duration_sec').notNull(),
  configVersion: integer('config_version').notNull(),
  stats: jsonb('stats'),
  equityCurve: jsonb('equity_curve').notNull(),
  error: text('error'),
  notes: text('notes').notNull(),
});

export const backtestTrades = pgTable(
  'backtest_trades',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => backtestRuns.id, { onDelete: 'cascade' }),
    symbol: text('symbol').notNull(),
    strategy: text('strategy').notNull(),
    netPnl: money('net_pnl').notNull(),
    exitAt: ts('exit_at').notNull(),
    data: jsonb('data').notNull(),
  },
  (t) => [index('backtest_trades_run').on(t.runId)],
);

export const kvState = pgTable('kv_state', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: ts('updated_at').notNull(),
});
