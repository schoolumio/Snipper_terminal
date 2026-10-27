import type { AgentId, AuditResult, PipelineStage } from '@sniper/core/types';
import { Activity, BookText, Calculator, Crosshair, DoorOpen, Gauge, Radar, ShieldAlert, Workflow, type LucideIcon } from 'lucide-react';
import type { Tone } from '@/components/ui/badge';

export const AGENT_META: Record<AgentId, { color: string; tone: Tone; icon: LucideIcon; tag: string }> = {
  scanner: { color: 'var(--color-scan)', tone: 'scan', icon: Radar, tag: 'SCAN' },
  risk: { color: 'var(--color-risk)', tone: 'risk', icon: ShieldAlert, tag: 'RISK' },
  strategy: { color: 'var(--color-signal)', tone: 'signal', icon: Activity, tag: 'SGNL' },
  sizer: { color: 'var(--color-size)', tone: 'size', icon: Calculator, tag: 'SIZE' },
  executor: { color: 'var(--color-exec)', tone: 'exec', icon: Crosshair, tag: 'EXEC' },
  exit: { color: 'var(--color-exit)', tone: 'exit', icon: DoorOpen, tag: 'EXIT' },
  equity: { color: 'var(--color-equity)', tone: 'equity', icon: Gauge, tag: 'EQTY' },
  logger: { color: 'var(--color-log)', tone: 'log', icon: BookText, tag: 'AUDT' },
  orchestrator: { color: 'var(--color-orch)', tone: 'neutral', icon: Workflow, tag: 'ORCH' },
};

export const RESULT_TONE: Record<AuditResult, Tone> = {
  ok: 'equity',
  pass: 'signal',
  review: 'warn',
  reject: 'risk',
  skip: 'neutral',
  blocked: 'warn',
  enter: 'exec',
  exit: 'exit',
  error: 'down',
  warn: 'warn',
  info: 'log',
};

export interface Lane {
  id: string;
  label: string;
  agent: AgentId;
  stages: PipelineStage[];
}

export const LANES: Lane[] = [
  { id: 'scan', label: 'Scan', agent: 'scanner', stages: ['DISCOVERED'] },
  { id: 'risk', label: 'Risk check', agent: 'risk', stages: ['SCREENING'] },
  { id: 'strategy', label: 'Strategy', agent: 'strategy', stages: ['ELIGIBLE', 'SIGNAL_EVALUATION'] },
  { id: 'size', label: 'Size', agent: 'sizer', stages: ['TRADE_PROPOSED', 'RISK_APPROVED'] },
  { id: 'exec', label: 'Execute', agent: 'executor', stages: ['EXECUTION_PENDING'] },
  { id: 'monitor', label: 'Monitor', agent: 'exit', stages: ['OPEN', 'RECONCILIATION_REQUIRED'] },
  { id: 'exit', label: 'Exit', agent: 'equity', stages: ['EXIT_PENDING', 'CLOSED'] },
];

export const STAGE_TONE: Partial<Record<PipelineStage, Tone>> = {
  DISCOVERED: 'scan',
  SCREENING: 'risk',
  ELIGIBLE: 'signal',
  SIGNAL_EVALUATION: 'signal',
  TRADE_PROPOSED: 'size',
  RISK_APPROVED: 'size',
  EXECUTION_PENDING: 'exec',
  OPEN: 'exec',
  EXIT_PENDING: 'exit',
  CLOSED: 'equity',
  REJECTED: 'risk',
  EXPIRED: 'neutral',
  FAILED: 'down',
  CANCELLED: 'neutral',
  RECONCILIATION_REQUIRED: 'warn',
};

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <rect x="1" y="1" width="30" height="30" rx="7" stroke="var(--color-ink-500)" />
      <circle cx="16" cy="16" r="8.5" stroke="var(--color-exec)" strokeWidth="1.5" />
      <circle cx="16" cy="16" r="2.2" fill="var(--color-exec)" />
      <path d="M16 3.5v6M16 22.5v6M3.5 16h6M22.5 16h6" stroke="var(--color-ink-300)" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
