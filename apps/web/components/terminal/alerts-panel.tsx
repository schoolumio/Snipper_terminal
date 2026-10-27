'use client';

import { Check, X } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, Panel } from '@/components/ui/panel';
import { api } from '@/lib/api';
import { age, usd } from '@/lib/format';
import { useNow, useTerminal } from '@/lib/terminal-store';
import { cn } from '@/lib/utils';

export function AlertsPanel() {
  const { state, isAdmin, openCandidate } = useTerminal();
  const now = useNow(5000);
  const [err, setErr] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  const alerts = state.alerts.filter((a) => !a.acknowledged).slice(0, 25);
  return (
    <Panel index="06" title="Approvals & alerts" accent="var(--color-warn)" right={<span className="num text-[10px] text-ink-400">{alerts.length} unread</span>} bodyClassName="max-h-[340px] overflow-y-auto">
      {state.approvals.map((p) => (
        <div key={p.id} className="border-b border-ink-700/60 bg-warn/5 px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <button onClick={() => openCandidate(p.candidateId)} className="font-mono text-[12px] font-semibold hover:underline">
              ${p.symbol}
            </button>
            <Badge tone="warn">approval · {Math.max(0, Math.round((p.expiresAt - now) / 1000))}s</Badge>
          </div>
          <div className="mt-0.5 font-mono text-[10.5px] text-ink-400">
            {p.strategy} · {usd(p.size)} · risk {p.riskVerdict} {p.riskScore} · {p.statusReason}
          </div>
          {isAdmin && (
            <div className="mt-1.5 flex gap-1.5">
              <Button size="sm" variant="success" onClick={() => act(() => api(`/api/proposals/${p.id}/approve`, { method: 'POST' }))}>
                <Check size={11} /> approve
              </Button>
              <Button size="sm" variant="danger" onClick={() => act(() => api(`/api/proposals/${p.id}/reject`, { method: 'POST' }))}>
                <X size={11} /> reject
              </Button>
            </div>
          )}
        </div>
      ))}
      {err && <div className="px-3 py-1 font-mono text-[11px] text-down">{err}</div>}
      {alerts.length === 0 && state.approvals.length === 0 ? (
        <Empty>no unread alerts</Empty>
      ) : (
        alerts.map((a) => (
          <div key={a.id} className="group flex items-start gap-2 border-b border-ink-800 px-3 py-1.5">
            <span className={cn('mt-1 h-1.5 w-1.5 shrink-0 rounded-full', a.level === 'critical' ? 'bg-down' : a.level === 'warning' ? 'bg-warn' : 'bg-log')} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className={cn('truncate text-[12px]', a.level === 'critical' ? 'text-down' : 'text-ink-200')}>{a.title}</span>
                <span className="num shrink-0 text-[10px] text-ink-500">
                  {a.mode === 'live' ? 'LIVE · ' : ''}
                  {age(now - a.ts)}
                </span>
              </div>
              <div className="truncate font-mono text-[10.5px] text-ink-500">{a.message}</div>
            </div>
            <button title="acknowledge" onClick={() => act(() => api(`/api/alerts/${a.id}/ack`, { method: 'POST' }))} className="shrink-0 text-ink-600 opacity-0 hover:text-ink-200 group-hover:opacity-100">
              <Check size={12} />
            </button>
          </div>
        ))
      )}
    </Panel>
  );
}
