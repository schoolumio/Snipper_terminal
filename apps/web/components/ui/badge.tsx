import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export type Tone = 'neutral' | 'scan' | 'risk' | 'signal' | 'size' | 'exec' | 'exit' | 'equity' | 'log' | 'warn' | 'up' | 'down' | 'live';

const TONES: Record<Tone, string> = {
  neutral: 'border-ink-600 text-ink-300 bg-ink-800',
  scan: 'border-scan/40 text-scan bg-scan/10',
  risk: 'border-risk/40 text-risk bg-risk/10',
  signal: 'border-signal/40 text-signal bg-signal/10',
  size: 'border-size/40 text-size bg-size/10',
  exec: 'border-exec/40 text-exec bg-exec/10',
  exit: 'border-exit/40 text-exit bg-exit/10',
  equity: 'border-equity/40 text-equity bg-equity/10',
  log: 'border-log/40 text-log bg-log/10',
  warn: 'border-warn/40 text-warn bg-warn/10',
  up: 'border-up/40 text-up bg-up/10',
  down: 'border-down/40 text-down bg-down/10',
  live: 'border-live/60 text-live bg-live/15',
};

export function Badge({ tone = 'neutral', className, ...p }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return <span className={cn('inline-flex h-[18px] items-center gap-1 rounded-[3px] border px-1.5 font-mono text-[10px] uppercase leading-none tracking-[0.08em]', TONES[tone], className)} {...p} />;
}
