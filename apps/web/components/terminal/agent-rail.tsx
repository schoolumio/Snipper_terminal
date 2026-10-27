'use client';

import type { AgentStatus } from '@sniper/core/types';
import { Badge } from '@/components/ui/badge';
import { Panel } from '@/components/ui/panel';
import { age } from '@/lib/format';
import { useNow, useTerminal } from '@/lib/terminal-store';
import { cn } from '@/lib/utils';
import { AGENT_META } from './meta';

const STATE_TONE = { idle: 'neutral', working: 'scan', ok: 'equity', warning: 'warn', error: 'down', blocked: 'warn', disabled: 'neutral' } as const;

export function AgentRail() {
  const { state } = useTerminal();
  const online = state.agents.filter((a) => a.state !== 'error' && a.state !== 'disabled').length;
  return (
    <Panel index="01" title="Agents" right={<span className="num text-[10px] text-ink-400">{online} online</span>} bodyClassName="p-2 space-y-1.5">
      {state.agents.map((a) => (
        <AgentCard key={a.id} a={a} />
      ))}
    </Panel>
  );
}

function AgentCard({ a }: { a: AgentStatus }) {
  const { openAgent } = useTerminal();
  const now = useNow(2000);
  const m = AGENT_META[a.id];
  const Icon = m.icon;
  const err = a.state === 'error';
  return (
    <button
      onClick={() => openAgent(a.id)}
      className={cn('group relative w-full overflow-hidden rounded-[5px] border bg-ink-900/60 px-2.5 py-2 text-left transition-colors hover:bg-ink-800/80', err ? 'border-down/50' : 'border-ink-700/80 hover:border-ink-600')}
    >
      <span className="absolute inset-y-0 left-0 w-[2px]" style={{ background: m.color, opacity: a.state === 'idle' ? 0.35 : 1 }} />
      <div className="flex items-center gap-2">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-[4px] border" style={{ borderColor: `color-mix(in oklab, ${m.color} 45%, transparent)`, background: `color-mix(in oklab, ${m.color} 12%, transparent)` }}>
          <Icon size={13} style={{ color: m.color }} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-[12.5px] font-medium text-ink-100">{a.name}</span>
            <Badge tone={STATE_TONE[a.state]}>{a.state}</Badge>
          </div>
          <div className="truncate text-[10.5px] text-ink-500">{a.role}</div>
        </div>
      </div>
      <div className="mt-1.5 space-y-0.5 pl-8 font-mono text-[10.5px] leading-snug">
        <div className="truncate text-ink-300">{a.currentTask ?? a.lastAction ?? 'waiting'}</div>
        {a.lastDecision && <div className="truncate text-ink-500">↳ {a.lastDecision}</div>}
        {(a.warning || (err && a.errors[0])) && <div className={cn('truncate', err ? 'text-down' : 'text-warn')}>! {err ? a.errors[0]?.message : a.warning}</div>}
      </div>
      <div className="absolute right-2 top-[30px] num text-[9.5px] text-ink-600 opacity-0 transition-opacity group-hover:opacity-100">{age(now - a.lastUpdate)}</div>
    </button>
  );
}
