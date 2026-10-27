import type { EngineConfig } from '../config';
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
  PoolInfo,
  Position,
  PositionEvent,
  ProviderHealth,
  RiskAssessment,
  SizingDecision,
  StrategySignal,
  Trade,
  TradeProposal,
  TradingMode,
} from '../types';

export interface ConfigVersion {
  version: number;
  config: EngineConfig;
  changedBy: string;
  changedAt: number;
  note: string;
}

/**
 * A unit of work. `Store.write` must apply a batch atomically: either every
 * record is persisted or none is. Records are upserted by id, except audit
 * events, position events and snapshots which are append-only.
 */
export interface WriteBatch {
  pools?: PoolInfo[];
  candidates?: Candidate[];
  snapshots?: MarketSnapshot[];
  assessments?: RiskAssessment[];
  signals?: StrategySignal[];
  proposals?: TradeProposal[];
  sizing?: SizingDecision[];
  orders?: Order[];
  transactions?: ChainTransaction[];
  positions?: Position[];
  positionEvents?: PositionEvent[];
  trades?: Trade[];
  audit?: AuditEvent[];
  equity?: EquitySnapshot[];
  alerts?: Alert[];
  ledgers?: Ledger[];
  configs?: ConfigVersion[];
  providerHealth?: ProviderHealth[];
  kv?: { key: string; value: string }[];
}

export interface PersistedState {
  config: ConfigVersion | null;
  ledgers: Ledger[];
  /** Positions that are not closed / failed. */
  openPositions: Position[];
  recentPositions: Position[];
  /** Orders that were not settled when the process stopped. */
  pendingOrders: Order[];
  /** Candidates in non-terminal stages. */
  activeCandidates: Candidate[];
  recentTrades: Trade[];
  recentAudit: AuditEvent[];
  recentAlerts: Alert[];
  equity: EquitySnapshot[];
  lastAuditSeq: number;
  kv: Record<string, string>;
  counters: { txSubmitted: number; txFailed: number };
}

export interface TradeQuery {
  mode?: TradingMode;
  symbol?: string;
  strategy?: string;
  exitReason?: string;
  from?: number;
  to?: number;
  limit?: number;
  offset?: number;
}

export interface AuditQuery {
  agent?: string;
  result?: string;
  correlationId?: string;
  positionId?: string;
  search?: string;
  mode?: TradingMode;
  from?: number;
  to?: number;
  limit?: number;
  beforeSeq?: number;
}

export interface Store {
  readonly persistent: boolean;
  init(): Promise<void>;
  close(): Promise<void>;
  write(batch: WriteBatch): Promise<void>;
  load(): Promise<PersistedState>;
  listTrades(q: TradeQuery): Promise<{ rows: Trade[]; total: number }>;
  listAudit(q: AuditQuery): Promise<AuditEvent[]>;
  listEquity(mode: TradingMode, since: number, limit: number): Promise<EquitySnapshot[]>;
  listConfigVersions(limit: number): Promise<ConfigVersion[]>;
  getPosition(id: string): Promise<Position | null>;
  getPositionEvents(positionId: string): Promise<PositionEvent[]>;
  getOrders(filter: { positionId?: string; candidateId?: string }): Promise<Order[]>;
  getTransactions(orderIds: string[]): Promise<ChainTransaction[]>;
  getCandidate(id: string): Promise<Candidate | null>;
  getAssessments(candidateId: string): Promise<RiskAssessment[]>;
  getSignals(candidateId: string): Promise<StrategySignal[]>;
  getProposals(candidateId: string): Promise<TradeProposal[]>;
  getSizing(candidateId: string): Promise<SizingDecision[]>;
  listAlerts(limit: number): Promise<Alert[]>;
  saveBacktest(run: BacktestRunSummary, trades: Trade[]): Promise<void>;
  listBacktests(limit: number): Promise<BacktestRunSummary[]>;
  getBacktest(id: string): Promise<{ run: BacktestRunSummary; trades: Trade[] } | null>;
  /** Retention: delete market snapshots older than `before`. Returns rows removed. */
  pruneSnapshots(before: number): Promise<number>;
}
