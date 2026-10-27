import type { Candidate, PipelineStage } from './types';

export const TERMINAL_STAGES: ReadonlySet<PipelineStage> = new Set(['REJECTED', 'CLOSED', 'EXPIRED', 'FAILED', 'CANCELLED']);

/**
 * Allowed pipeline transitions. Anything not listed is a programming error and
 * throws, so an agent can never skip a required stage (e.g. ELIGIBLE → OPEN).
 */
export const TRANSITIONS: Readonly<Record<PipelineStage, readonly PipelineStage[]>> = {
  DISCOVERED: ['SCREENING', 'EXPIRED', 'CANCELLED'],
  SCREENING: ['REJECTED', 'ELIGIBLE', 'FAILED'],
  ELIGIBLE: ['SIGNAL_EVALUATION', 'EXPIRED', 'CANCELLED', 'REJECTED'],
  SIGNAL_EVALUATION: ['ELIGIBLE', 'TRADE_PROPOSED', 'REJECTED', 'EXPIRED'],
  // ELIGIBLE = deferred because of portfolio state rather than the token itself.
  TRADE_PROPOSED: ['RISK_APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'ELIGIBLE'],
  RISK_APPROVED: ['EXECUTION_PENDING', 'REJECTED', 'EXPIRED', 'CANCELLED', 'ELIGIBLE'],
  EXECUTION_PENDING: ['OPEN', 'FAILED', 'RECONCILIATION_REQUIRED'],
  OPEN: ['EXIT_PENDING', 'RECONCILIATION_REQUIRED'],
  EXIT_PENDING: ['OPEN', 'CLOSED', 'RECONCILIATION_REQUIRED'],
  RECONCILIATION_REQUIRED: ['OPEN', 'CLOSED', 'FAILED'],
  REJECTED: [],
  CLOSED: [],
  EXPIRED: [],
  FAILED: [],
  CANCELLED: [],
};

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: PipelineStage,
    public readonly to: PipelineStage,
  ) {
    super(`invalid pipeline transition ${from} → ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function canTransition(from: PipelineStage, to: PipelineStage): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Mutates the candidate in place; throws on an invalid transition. */
export function transition(c: Candidate, to: PipelineStage, reason: string | null, now: number): Candidate {
  if (!canTransition(c.stage, to)) throw new InvalidTransitionError(c.stage, to);
  c.stage = to;
  c.stageReason = reason;
  c.updatedAt = now;
  c.stageHistory.push({ stage: to, ts: now, reason });
  if (c.stageHistory.length > 50) c.stageHistory.splice(0, c.stageHistory.length - 50);
  return c;
}

export function isTerminal(stage: PipelineStage): boolean {
  return TERMINAL_STAGES.has(stage);
}
