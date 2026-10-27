/**
 * Shared domain types. This module must stay free of runtime imports so the
 * web app can depend on it without pulling engine code into the browser.
 */

export type Dec = string;
export type Millis = number;

export type ChainId = 'solana' | 'simnet';
export type TradingMode = 'paper' | 'live';
export type Side = 'buy' | 'sell';

export type AgentId =
  | 'scanner'
  | 'risk'
  | 'strategy'
  | 'sizer'
  | 'executor'
  | 'exit'
  | 'equity'
  | 'logger'
  | 'orchestrator';

export const AGENT_IDS: readonly AgentId[] = [
  'scanner',
  'risk',
  'strategy',
  'sizer',
  'executor',
  'exit',
  'equity',
  'logger',
  'orchestrator',
] as const;

export type AgentState = 'idle' | 'working' | 'ok' | 'warning' | 'error' | 'blocked' | 'disabled';

export interface AgentStatus {
  id: AgentId;
  name: string;
  role: string;
  state: AgentState;
  currentTask: string | null;
  lastAction: string | null;
  lastDecision: string | null;
  lastUpdate: Millis;
  counters: Record<string, number>;
  errors: { ts: Millis; message: string }[];
  warning: string | null;
}

// ───────────────────────── market data ─────────────────────────

export interface TokenRef {
  chain: ChainId;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
}

export interface PoolInfo {
  chain: ChainId;
  address: string;
  dex: string;
  token: TokenRef;
  quoteSymbol: string;
  quoteAddress: string;
  createdAt: Millis;
  discoveredAt: Millis;
  source: string;
}

export interface TxCounts {
  buys: number;
  sells: number;
}

export interface MarketSnapshot {
  chain: ChainId;
  poolAddress: string;
  tokenAddress: string;
  /** Time the data describes (provider timestamp). */
  ts: Millis;
  /** Time we received it. */
  fetchedAt: Millis;
  source: string;
  /** Mid price, quote per 1 whole token. */
  price: Dec;
  /** Pool liquidity expressed in quote terms (both sides). */
  liquidity: Dec;
  /** Estimated market cap in quote terms, null when supply is not reliably known. */
  marketCap: Dec | null;
  volume: { m1: Dec; m5: Dec; h1: Dec };
  txns: { m5: TxCounts; h1: TxCounts };
  priceChange: { m1: Dec | null; m5: Dec | null; h1: Dec | null };
  holders: number | null;
  uniqueTraders5m: number | null;
}

export interface QuoteRequest {
  chain: ChainId;
  poolAddress: string;
  tokenAddress: string;
  side: Side;
  /** buy: quote currency in; sell: token amount in. */
  amountIn: Dec;
}

export interface Quote {
  id: string;
  chain: ChainId;
  poolAddress: string;
  tokenAddress: string;
  side: Side;
  amountIn: Dec;
  expectedOut: Dec;
  /** Mid price before the trade (quote per token). */
  midPrice: Dec;
  /** Effective execution price (quote per token). */
  effectivePrice: Dec;
  priceImpactPct: Dec;
  /** Swap/LP fee in quote terms (already reflected in expectedOut). */
  swapFeeQuote: Dec;
  /** Estimated network + priority fee in quote terms (paid separately). */
  networkFeeQuote: Dec;
  ts: Millis;
  expiresAt: Millis;
  source: string;
}

// ───────────────────────── security ─────────────────────────

export interface LpLockInfo {
  claimed: boolean;
  /** true only when independently verified on-chain / by evidence. */
  verified: boolean | null;
  lockedPct: Dec | null;
  unlockAt: Millis | null;
  evidence: string | null;
}

/** Raw signals from a security provider. null = unknown / unavailable. */
export interface SecurityReport {
  chain: ChainId;
  tokenAddress: string;
  source: string;
  fetchedAt: Millis;
  mintAuthorityRenounced: boolean | null;
  freezeAuthorityRenounced: boolean | null;
  top10HolderPct: Dec | null;
  creatorHoldingPct: Dec | null;
  holderCount: number | null;
  lpLock: LpLockInfo | null;
  /** Result of a simulated sell; false indicates a honeypot / sell restriction. */
  sellSimulationOk: boolean | null;
  transferTaxPct: Dec | null;
  creatorPriorFlaggedTokens: number | null;
  knownMalicious: boolean | null;
  providerFlags: string[];
}

export type RiskVerdict = 'PASS' | 'REVIEW' | 'REJECT';
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface RiskFactor {
  code: string;
  severity: Severity;
  message: string;
  value: string | null;
  source: string;
  observedAt: Millis;
  /** When true this factor alone blocks the trade. */
  blocking: boolean;
}

export interface RiskAssessment {
  id: string;
  candidateId: string;
  chain: ChainId;
  tokenAddress: string;
  poolAddress: string;
  ts: Millis;
  verdict: RiskVerdict;
  riskScore: number;
  confidence: number;
  factors: RiskFactor[];
  summary: string;
  configVersion: number;
  phase: 'screening' | 'pre_execution';
}

// ───────────────────────── strategy ─────────────────────────

export type StrategyId = 'new_pool_entry' | 'volume_spike' | 'price_breakout' | 'pullback_entry' | 'liquidity_momentum';

export interface TakeProfitLevel {
  gainPct: Dec;
  /** Fraction (0..1] of the *remaining* position to sell at this level. */
  sellFraction: Dec;
}

export interface ExitPolicy {
  version: number;
  stopLossPct: Dec;
  takeProfit: TakeProfitLevel[];
  trailing: { enabled: boolean; activateAtGainPct: Dec; trailPct: Dec };
  breakEven: { enabled: boolean; triggerGainPct: Dec };
  maxHoldSec: number;
  momentumReversal: { enabled: boolean; m5DropPct: Dec; sellBuyRatio: Dec };
  liquidityDropPct: Dec;
}

export interface StrategySignal {
  id: string;
  candidateId: string;
  strategy: StrategyId;
  strategyVersion: string;
  ts: Millis;
  dataTs: Millis;
  score: number;
  confidence: number;
  rationale: string;
  entryConditions: string[];
  invalidation: string[];
  referencePrice: Dec;
  maxEntryPrice: Dec;
  exitPolicy: ExitPolicy;
  metrics: Record<string, number | string | null>;
}

// ───────────────────────── sizing / proposals ─────────────────────────

export interface SizingConstraint {
  name: string;
  limit: Dec;
  binding: boolean;
}

export interface SizingDecision {
  id: string;
  candidateId: string;
  ts: Millis;
  approved: boolean;
  /** Deferred = portfolio state blocked it now; token may be retried later. */
  deferred: boolean;
  size: Dec;
  maxAllowed: Dec;
  equity: Dec;
  available: Dec;
  reserved: Dec;
  openExposure: Dec;
  estEntryCost: Dec;
  estExitCost: Dec;
  estDownside: Dec;
  remainingRiskBudget: Dec;
  constraints: SizingConstraint[];
  reasons: string[];
  configVersion: number;
}

export type ProposalStatus = 'proposed' | 'awaiting_approval' | 'approved' | 'rejected' | 'expired' | 'cancelled' | 'executed';

export interface TradeProposal {
  id: string;
  candidateId: string;
  mode: TradingMode;
  chain: ChainId;
  tokenAddress: string;
  poolAddress: string;
  symbol: string;
  strategy: StrategyId;
  strategyVersion: string;
  signalId: string;
  signalScore: number;
  signalConfidence: number;
  rationale: string;
  entryConditions: string[];
  invalidation: string[];
  size: Dec;
  maxEntryPrice: Dec;
  exitPolicy: ExitPolicy;
  maxHoldSec: number;
  estFeesQuote: Dec;
  estSlippagePct: Dec;
  estPriceImpactPct: Dec;
  dataTs: Millis;
  createdAt: Millis;
  expiresAt: Millis;
  status: ProposalStatus;
  statusReason: string | null;
  riskVerdict: RiskVerdict;
  riskScore: number;
  sizingDecisionId: string | null;
}

// ───────────────────────── execution ─────────────────────────

export type OrderStatus = 'created' | 'submitted' | 'confirmed' | 'failed' | 'cancelled' | 'unknown';
export type OrderPurpose = 'entry' | 'exit';

export interface Order {
  id: string;
  idempotencyKey: string;
  mode: TradingMode;
  chain: ChainId;
  purpose: OrderPurpose;
  side: Side;
  candidateId: string;
  positionId: string | null;
  proposalId: string | null;
  tokenAddress: string;
  poolAddress: string;
  symbol: string;
  amountIn: Dec;
  minOut: Dec;
  quotedOut: Dec;
  maxSlippagePct: Dec;
  priorityFeeQuote: Dec;
  /** Quote currency reserved in the ledger for this order (entries only). */
  reservedQuote: Dec;
  /** Swap/LP fee from the pre-submission quote. */
  estSwapFeeQuote: Dec;
  status: OrderStatus;
  statusReason: string | null;
  txId: string | null;
  filledIn: Dec | null;
  filledOut: Dec | null;
  fillPrice: Dec | null;
  networkFeeQuote: Dec | null;
  slippagePct: Dec | null;
  reason: string;
  createdAt: Millis;
  submittedAt: Millis | null;
  settledAt: Millis | null;
  attempts: number;
}

export type TxStatus = 'pending' | 'confirmed' | 'failed' | 'unknown';

export interface ChainTransaction {
  id: string;
  orderId: string;
  mode: TradingMode;
  chain: ChainId;
  signature: string;
  status: TxStatus;
  error: string | null;
  networkFeeQuote: Dec | null;
  submittedAt: Millis;
  confirmedAt: Millis | null;
  simulated: boolean;
  explorerUrl: string | null;
}

// ───────────────────────── positions ─────────────────────────

export type PositionStatus = 'pending' | 'open' | 'exit_pending' | 'closed' | 'failed' | 'reconciliation_required';

export interface PositionMark {
  ts: Millis;
  /** Executable sell value for the remaining quantity, net of network fee. */
  liquidationValue: Dec | null;
  /** qty * mid price — mark-to-market, not necessarily achievable. */
  markValue: Dec | null;
  midPrice: Dec | null;
  priceImpactPct: Dec | null;
  liquidity: Dec | null;
  unrealizedPnl: Dec | null;
  unrealizedPnlPct: Dec | null;
  quoteError: string | null;
}

export interface Position {
  id: string;
  mode: TradingMode;
  chain: ChainId;
  candidateId: string;
  proposalId: string;
  tokenAddress: string;
  poolAddress: string;
  symbol: string;
  strategy: StrategyId;
  strategyVersion: string;
  status: PositionStatus;
  entryQty: Dec;
  qty: Dec;
  /** Total quote spent including network fee. */
  costBasis: Dec;
  /** Cost basis of the quantity still held. */
  openCostBasis: Dec;
  entryFillPrice: Dec;
  entryFeesQuote: Dec;
  entryLiquidity: Dec;
  exitFeesQuote: Dec;
  proceeds: Dec;
  realizedPnl: Dec;
  exitPolicy: ExitPolicy;
  highWaterValuePerToken: Dec;
  stopPricePerToken: Dec;
  trailingActive: boolean;
  breakEvenArmed: boolean;
  tpLevelsHit: number;
  exitFailures: number;
  unsellable: boolean;
  openedAt: Millis;
  closedAt: Millis | null;
  lastMark: PositionMark | null;
  riskScore: number;
  entryRationale: string;
  exitReason: string | null;
  exitRationale: string | null;
  orderIds: string[];
}

export type PositionEventType =
  | 'opened'
  | 'marked'
  | 'stop_moved'
  | 'trailing_activated'
  | 'take_profit'
  | 'exit_triggered'
  | 'exit_failed'
  | 'partial_exit'
  | 'closed'
  | 'reconciliation';

export interface PositionEvent {
  id: string;
  positionId: string;
  ts: Millis;
  type: PositionEventType;
  detail: string;
  data: Record<string, string | number | boolean | null>;
}

export interface Trade {
  id: string;
  positionId: string;
  mode: TradingMode;
  chain: ChainId;
  tokenAddress: string;
  poolAddress: string;
  symbol: string;
  strategy: StrategyId;
  candidateId: string;
  entryAt: Millis;
  exitAt: Millis;
  entryPrice: Dec;
  exitPrice: Dec;
  size: Dec;
  qty: Dec;
  grossPnl: Dec;
  fees: Dec;
  netPnl: Dec;
  returnPct: Dec;
  holdSec: number;
  exitReason: string;
  txStatus: 'confirmed' | 'partial' | 'written_off';
  slippagePct: Dec;
}

// ───────────────────────── portfolio ─────────────────────────

export interface Ledger {
  mode: TradingMode;
  currency: string;
  startingEquity: Dec;
  cash: Dec;
  reserved: Dec;
  deposits: Dec;
  withdrawals: Dec;
  realizedPnl: Dec;
  feesPaid: Dec;
  peakEquity: Dec;
  dayStartEquity: Dec;
  dayKey: string;
  updatedAt: Millis;
}

export interface EquitySnapshot {
  id: string;
  mode: TradingMode;
  ts: Millis;
  equity: Dec;
  cash: Dec;
  reserved: Dec;
  openLiquidationValue: Dec;
  openMarkValue: Dec;
  realizedPnl: Dec;
  unrealizedPnl: Dec;
  drawdownPct: Dec;
  openPositions: number;
  unvaluedPositions: number;
}

export interface PerformanceStats {
  mode: TradingMode;
  startingEquity: Dec;
  equity: Dec;
  available: Dec;
  reserved: Dec;
  realizedPnl: Dec;
  unrealizedPnl: Dec;
  grossProfit: Dec;
  grossLoss: Dec;
  feesPaid: Dec;
  netPnl: Dec;
  dailyPnl: Dec;
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgWin: Dec | null;
  avgLoss: Dec | null;
  profitFactor: number | null;
  avgHoldSec: number | null;
  avgSlippagePct: Dec | null;
  maxDrawdownPct: Dec;
  currentDrawdownPct: Dec;
  openPositions: number;
  openExposure: Dec;
  unvaluedPositions: number;
  failedTxRate: number | null;
  byStrategy: Record<string, { trades: number; wins: number; netPnl: Dec }>;
}

// ───────────────────────── pipeline ─────────────────────────

export type PipelineStage =
  | 'DISCOVERED'
  | 'SCREENING'
  | 'REJECTED'
  | 'ELIGIBLE'
  | 'SIGNAL_EVALUATION'
  | 'TRADE_PROPOSED'
  | 'RISK_APPROVED'
  | 'EXECUTION_PENDING'
  | 'OPEN'
  | 'EXIT_PENDING'
  | 'CLOSED'
  | 'EXPIRED'
  | 'FAILED'
  | 'CANCELLED'
  | 'RECONCILIATION_REQUIRED';

export interface Candidate {
  id: string;
  chain: ChainId;
  pool: PoolInfo;
  stage: PipelineStage;
  stageReason: string | null;
  stageHistory: { stage: PipelineStage; ts: Millis; reason: string | null }[];
  discoveredAt: Millis;
  updatedAt: Millis;
  expiresAt: Millis;
  scannerScore: number;
  snapshot: MarketSnapshot | null;
  riskVerdict: RiskVerdict | null;
  riskScore: number | null;
  riskAssessmentId: string | null;
  signalScore: number | null;
  strategy: StrategyId | null;
  proposalId: string | null;
  positionId: string | null;
  lastEvaluatedAt: Millis | null;
  evaluations: number;
  nextEvalAt: Millis;
}

// ───────────────────────── audit / alerts ─────────────────────────

export type AuditResult = 'ok' | 'pass' | 'review' | 'reject' | 'skip' | 'blocked' | 'enter' | 'exit' | 'error' | 'warn' | 'info';

export interface AuditEvent {
  id: string;
  seq: number;
  ts: Millis;
  correlationId: string | null;
  agent: AgentId;
  action: string;
  result: AuditResult;
  mode: TradingMode;
  tokenAddress: string | null;
  symbol: string | null;
  positionId: string | null;
  sizeQuote: Dec | null;
  reason: string;
  metrics: Record<string, string | number | boolean | null>;
  configVersion: number;
  strategyVersion: string | null;
}

export type AlertLevel = 'info' | 'warning' | 'critical';

export interface Alert {
  id: string;
  ts: Millis;
  level: AlertLevel;
  kind: string;
  title: string;
  message: string;
  mode: TradingMode;
  acknowledged: boolean;
  correlationId: string | null;
}

export interface ProviderHealth {
  provider: string;
  kind: 'market' | 'security' | 'execution';
  ok: boolean;
  lastSuccessAt: Millis | null;
  lastErrorAt: Millis | null;
  lastError: string | null;
  consecutiveFailures: number;
  latencyMs: number | null;
}

export interface CircuitBreakerState {
  id: string;
  label: string;
  tripped: boolean;
  reason: string | null;
  since: Millis | null;
  until: Millis | null;
}

export interface EngineStatus {
  name: string;
  version: string;
  mode: TradingMode;
  liveAvailable: boolean;
  liveAuthorized: boolean;
  liveWallet: string | null;
  chain: ChainId;
  marketSource: string;
  simulatedMarket: boolean;
  running: boolean;
  entriesPaused: boolean;
  pauseReason: string | null;
  killSwitch: boolean;
  killSwitchPolicy: string;
  startedAt: Millis;
  now: Millis;
  lastMarketDataAt: Millis | null;
  lastTickAt: Millis | null;
  tickCount: number;
  health: 'ok' | 'degraded' | 'down';
  breakers: CircuitBreakerState[];
  providers: ProviderHealth[];
  configVersion: number;
  persistent: boolean;
}

export interface BacktestRunSummary {
  id: string;
  createdAt: Millis;
  status: 'running' | 'completed' | 'failed';
  dataSource: string;
  seed: number;
  durationSec: number;
  configVersion: number;
  stats: PerformanceStats | null;
  equityCurve: { ts: Millis; equity: Dec }[];
  error: string | null;
  notes: string;
}

export interface DashboardSnapshot {
  status: EngineStatus;
  agents: AgentStatus[];
  candidates: Candidate[];
  positions: Position[];
  performance: { paper: PerformanceStats; live: PerformanceStats };
  equity: { paper: EquitySnapshot[]; live: EquitySnapshot[] };
  audit: AuditEvent[];
  alerts: Alert[];
  counters: PipelineCounters;
  pendingApprovals: TradeProposal[];
}

export interface PipelineCounters {
  discovered: number;
  screened: number;
  rejected: number;
  eligible: number;
  proposed: number;
  approved: number;
  entered: number;
  exited: number;
  skipped: number;
  expired: number;
  txFailures: number;
  txSubmitted: number;
  avgSlippagePct: Dec | null;
}

export type EngineEvent =
  | { type: 'audit'; data: AuditEvent }
  | { type: 'agent'; data: AgentStatus }
  | { type: 'candidate'; data: Candidate }
  | { type: 'position'; data: Position }
  | { type: 'order'; data: Order }
  | { type: 'equity'; data: EquitySnapshot }
  | { type: 'alert'; data: Alert }
  | { type: 'status'; data: EngineStatus }
  | { type: 'counters'; data: PipelineCounters }
  | { type: 'performance'; data: { paper: PerformanceStats; live: PerformanceStats } }
  | { type: 'approval'; data: TradeProposal };
