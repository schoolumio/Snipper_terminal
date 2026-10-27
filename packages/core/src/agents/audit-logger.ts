import type { AgentId, AuditEvent, AuditResult, Dec, TradingMode } from '../types';
import { newId } from '../util/ids';

export interface AuditInput {
  agent: AgentId;
  action: string;
  result: AuditResult;
  reason: string;
  correlationId?: string | null;
  tokenAddress?: string | null;
  symbol?: string | null;
  positionId?: string | null;
  sizeQuote?: Dec | null;
  metrics?: Record<string, string | number | boolean | null>;
  strategyVersion?: string | null;
}

/**
 * Logger agent. Produces append-only, sequenced audit events. Events are
 * buffered until the orchestrator flushes the current unit of work so they are
 * persisted atomically with the state change they describe.
 */
export class AuditLogger {
  private seq: number;
  private buffer: AuditEvent[] = [];
  readonly recent: AuditEvent[] = [];

  constructor(
    lastSeq: number,
    private readonly ctx: () => { mode: TradingMode; configVersion: number; now: number },
    private readonly onEvent: (e: AuditEvent) => void,
    private readonly recentCap = 600,
  ) {
    this.seq = lastSeq;
  }

  log(i: AuditInput): AuditEvent {
    const c = this.ctx();
    const e: AuditEvent = {
      id: newId('ev', c.now),
      seq: ++this.seq,
      ts: c.now,
      correlationId: i.correlationId ?? null,
      agent: i.agent,
      action: i.action,
      result: i.result,
      mode: c.mode,
      tokenAddress: i.tokenAddress ?? null,
      symbol: i.symbol ?? null,
      positionId: i.positionId ?? null,
      sizeQuote: i.sizeQuote ?? null,
      reason: redact(i.reason),
      metrics: i.metrics ?? {},
      configVersion: c.configVersion,
      strategyVersion: i.strategyVersion ?? null,
    };
    this.buffer.push(e);
    this.recent.push(e);
    if (this.recent.length > this.recentCap) this.recent.splice(0, this.recent.length - this.recentCap);
    this.onEvent(e);
    return e;
  }

  resetSeq(seq: number): void {
    this.seq = seq;
  }

  seed(events: AuditEvent[]): void {
    this.recent.push(...events.slice(-this.recentCap));
  }

  drain(): AuditEvent[] {
    const out = this.buffer;
    this.buffer = [];
    return out;
  }

  get lastSeq(): number {
    return this.seq;
  }
}

// base58 64-byte secret keys, 32-byte hex keys, and JSON byte-array keypairs.
const SECRET_PATTERNS = [/\b[1-9A-HJ-NP-Za-km-z]{80,90}\b/g, /\b(?:0x)?[0-9a-fA-F]{64}\b/g, /\[\s*(?:\d{1,3}\s*,\s*){31,}\d{1,3}\s*\]/g];

/** Defence in depth: never let anything resembling key material into the log. */
export function redact(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[redacted]');
  return out;
}
