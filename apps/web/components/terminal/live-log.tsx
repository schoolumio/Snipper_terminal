'use client';

import type { AuditEvent } from '@sniper/core/types';
import { AGENT_IDS } from '@sniper/core/types';
import { Download, Pause, Play } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { Panel } from '@/components/ui/panel';
import { clock, usd } from '@/lib/format';
import { useTerminal } from '@/lib/terminal-store';
import { cn } from '@/lib/utils';
import { AGENT_META, RESULT_TONE } from './meta';

const RESULTS = ['enter', 'exit', 'pass', 'review', 'reject', 'skip', 'blocked', 'warn', 'error', 'info', 'ok'];

export function LiveLog({ className }: { className?: string }) {
  const { state, openCandidate } = useTerminal();
  const [agent, setAgent] = useState('');
  const [result, setResult] = useState('');
  const [q, setQ] = useState('');
  const [paused, setPaused] = useState(false);
  const [frozen, setFrozen] = useState<AuditEvent[] | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const source = paused ? (frozen ?? state.audit) : state.audit;
  const rows = useMemo(() => {
    const s = q.toLowerCase();
    return source.filter((e) => (!agent || e.agent === agent) && (!result || e.result === result) && (!s || `${e.action} ${e.reason} ${e.symbol ?? ''}`.toLowerCase().includes(s)));
  }, [source, agent, result, q]);

  useEffect(() => {
    if (!paused && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [rows, paused]);

  const exportHref = `/api/audit/export?format=csv${agent ? `&agent=${agent}` : ''}${result ? `&result=${result}` : ''}${q ? `&search=${encodeURIComponent(q)}` : ''}&limit=5000`;

  return (
    <Panel
      index="05"
      title="$ tail -f audit.log"
      accent="var(--color-log)"
      className={className}
      right={
        <>
          <span className="num text-[10px] text-ink-500">{rows.length} lines</span>
          <Button size="icon" variant="ghost" title={paused ? 'resume auto-scroll' : 'pause auto-scroll'} onClick={() => { setFrozen(paused ? null : state.audit); setPaused(!paused); }}>
            {paused ? <Play size={12} /> : <Pause size={12} />}
          </Button>
          <a href={exportHref} title="export CSV" className="grid h-7 w-7 place-items-center rounded text-ink-300 hover:bg-ink-800 hover:text-ink-100">
            <Download size={12} />
          </a>
        </>
      }
      bodyClassName="flex flex-col"
    >
      <div className="flex flex-wrap gap-1.5 border-b border-ink-700/60 px-2.5 py-2">
        <Select value={agent} onChange={(e) => setAgent(e.target.value)} className="h-7 flex-1" aria-label="agent filter">
          <option value="">all agents</option>
          {AGENT_IDS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </Select>
        <Select value={result} onChange={(e) => setResult(e.target.value)} className="h-7 flex-1" aria-label="result filter">
          <option value="">all results</option>
          {RESULTS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </Select>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="grep…" className="h-7 w-full" />
      </div>
      <div ref={ref} className="min-h-[300px] flex-1 overflow-y-auto bg-ink-950/40 px-2.5 py-2 font-mono text-[11px] leading-[1.5]">
        {rows.length === 0 && <div className="text-ink-500">waiting for events…</div>}
        {rows.map((e) => (
          <LogLine key={e.id} e={e} onClick={e.correlationId?.startsWith('cand_') ? () => openCandidate(e.correlationId) : undefined} />
        ))}
        {!paused && <span className="inline-block h-3 w-1.5 translate-y-0.5 animate-pulse bg-exec" />}
      </div>
    </Panel>
  );
}

function LogLine({ e, onClick }: { e: AuditEvent; onClick?: () => void }) {
  const m = AGENT_META[e.agent];
  const strong = e.result === 'enter' || e.result === 'exit' || e.result === 'error';
  return (
    <div onClick={onClick} className={cn('animate-enter group -mx-1 rounded px-1 py-[2px]', onClick && 'cursor-pointer hover:bg-ink-800/60', strong && 'bg-ink-800/30')}>
      <div className="flex items-baseline gap-1.5">
        <span className="shrink-0 text-ink-500">{clock(e.ts)}</span>
        <span className="w-9 shrink-0 font-semibold" style={{ color: m.color }}>
          {m.tag}
        </span>
        <Badge tone={RESULT_TONE[e.result]} className="h-[15px] shrink-0 px-1 text-[9px]">
          {e.result}
        </Badge>
        <span className="shrink-0 text-ink-200">{e.action}</span>
        {e.symbol && <span className="shrink-0 text-ink-100">${e.symbol}</span>}
        {e.sizeQuote && <span className="shrink-0 text-ink-400">{usd(e.sizeQuote)}</span>}
      </div>
      <div className="truncate pl-[3.75rem] text-ink-500 group-hover:whitespace-normal">
        <span className="text-ink-600">reason: </span>
        {e.reason}
      </div>
    </div>
  );
}
