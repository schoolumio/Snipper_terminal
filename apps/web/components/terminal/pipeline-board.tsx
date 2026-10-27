'use client';

import type { Candidate } from '@sniper/core/types';
import { STRATEGY_IDS } from '@sniper/core/config';
import { ChevronRight, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Input, Select } from '@/components/ui/input';
import { Empty, Panel } from '@/components/ui/panel';
import { age, compact, pct, price, toNum } from '@/lib/format';
import { useNow, useTerminal } from '@/lib/terminal-store';
import { cn } from '@/lib/utils';
import { AGENT_META, LANES, STAGE_TONE } from './meta';

const TERMINAL_BAD = new Set(['REJECTED', 'EXPIRED', 'FAILED', 'CANCELLED']);

export function PipelineBoard() {
  const { state } = useTerminal();
  const now = useNow();
  const [q, setQ] = useState('');
  const [strategy, setStrategy] = useState('');
  const [minLiq, setMinLiq] = useState('');
  const [maxRisk, setMaxRisk] = useState('');
  const [maxAge, setMaxAge] = useState('');

  const filtered = useMemo(() => {
    return state.candidates.filter((c) => {
      if (q && !c.pool.token.symbol.toLowerCase().includes(q.toLowerCase().replace(/^\$/, '')) && c.pool.token.address !== q) return false;
      if (strategy && c.strategy !== strategy) return false;
      if (minLiq && toNum(c.snapshot?.liquidity) < Number(minLiq)) return false;
      if (maxRisk && (c.riskScore ?? 0) > Number(maxRisk)) return false;
      if (maxAge && (now - c.pool.createdAt) / 60_000 > Number(maxAge)) return false;
      return true;
    });
  }, [state.candidates, q, strategy, minLiq, maxRisk, maxAge, now]);

  const lanes = LANES.map((l) => ({ ...l, items: filtered.filter((c) => l.stages.includes(c.stage)).sort((a, b) => b.updatedAt - a.updatedAt) }));
  const rejected = filtered.filter((c) => TERMINAL_BAD.has(c.stage)).sort((a, b) => b.updatedAt - a.updatedAt);
  const c = state.counters;

  return (
    <Panel
      index="02"
      title="Live flow · scan → risk → strategy → size → execute → monitor → exit"
      right={<span className="num hidden text-[10px] text-ink-400 sm:inline">{c ? `this session: ${c.discovered} seen · ${c.rejected} filtered · ${c.entered} entered` : ''}</span>}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-700/60 px-3 py-2">
        <div className="relative">
          <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-500" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="symbol / address" className="h-7 w-40 pl-6" />
        </div>
        <Select value={strategy} onChange={(e) => setStrategy(e.target.value)} className="h-7" aria-label="strategy">
          <option value="">all strategies</option>
          {STRATEGY_IDS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
        <Input value={minLiq} onChange={(e) => setMinLiq(e.target.value.replace(/[^\d.]/g, ''))} placeholder="min liq $" className="h-7 w-24" />
        <Input value={maxRisk} onChange={(e) => setMaxRisk(e.target.value.replace(/[^\d]/g, ''))} placeholder="max risk" className="h-7 w-20" />
        <Input value={maxAge} onChange={(e) => setMaxAge(e.target.value.replace(/[^\d]/g, ''))} placeholder="max age m" className="h-7 w-24" />
        <span className="num ml-auto text-[10px] text-ink-500">chain: {state.status?.chain ?? '—'}</span>
      </div>

      <div className="grid grid-cols-2 gap-px overflow-hidden bg-ink-700/50 sm:grid-cols-4 xl:grid-cols-7">
        {lanes.map((l, i) => {
          const m = AGENT_META[l.agent];
          return (
            <div key={l.id} className="flex min-h-[220px] min-w-0 flex-col bg-ink-850">
              <div className="relative flex items-center gap-1.5 px-2.5 pb-1.5 pt-2.5">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: m.color }} />
                <span className="label !text-ink-200">{l.label}</span>
                <span className="num ml-auto text-[11px]" style={{ color: l.items.length ? m.color : 'var(--color-ink-500)' }}>
                  {l.items.length}
                </span>
                {i < lanes.length - 1 && <ChevronRight size={11} className="absolute -right-[7px] top-[11px] z-10 hidden text-ink-500 xl:block" />}
              </div>
              <div className="conveyor mx-2.5 h-px opacity-60" style={{ ['--c' as string]: m.color }} />
              <div className="flex max-h-[300px] flex-1 flex-col gap-1 overflow-y-auto p-1.5">
                {l.items.length === 0 ? <Empty>—</Empty> : l.items.slice(0, 30).map((cand) => <TokenChip key={cand.id} c={cand} now={now} />)}
              </div>
            </div>
          );
        })}
      </div>

      <div className="border-t border-ink-700/60">
        <div className="flex items-center gap-2 px-3 pt-2">
          <span className="h-1.5 w-1.5 rounded-full bg-risk" />
          <span className="label !text-ink-200">filtered</span>
          <span className="num text-[10px] text-ink-500">rejected / expired / failed — click to inspect the reason</span>
        </div>
        <div className="flex gap-1.5 overflow-x-auto px-3 py-2">
          {rejected.length === 0 ? (
            <span className="font-mono text-[11px] text-ink-500">nothing filtered yet</span>
          ) : (
            rejected.slice(0, 40).map((cand) => <RejectChip key={cand.id} c={cand} />)
          )}
        </div>
      </div>
    </Panel>
  );
}

function TokenChip({ c, now }: { c: Candidate; now: number }) {
  const { openCandidate } = useTerminal();
  const s = c.snapshot;
  const chg = s?.priceChange.m5;
  return (
    <button onClick={() => openCandidate(c.id)} className="animate-enter w-full rounded-[4px] border border-ink-700 bg-ink-900/70 px-2 py-1.5 text-left transition-colors hover:border-ink-500">
      <div className="flex items-center justify-between gap-1">
        <span className="truncate font-mono text-[12px] font-semibold text-ink-100">${c.pool.token.symbol}</span>
        <span className="num text-[10px] text-ink-500">{age(now - c.pool.createdAt)}</span>
      </div>
      <div className="num mt-0.5 flex items-center justify-between gap-1 text-[10px]">
        <span className="text-ink-300">{s ? price(s.price) : '—'}</span>
        {chg !== null && chg !== undefined && <span className={toNum(chg) >= 0 ? 'text-up' : 'text-down'}>{pct(chg, { sign: true, dp: 1 })}</span>}
      </div>
      <div className="num mt-0.5 flex items-center justify-between gap-1 text-[10px] text-ink-500">
        <span>liq {s ? compact(s.liquidity) : '—'}</span>
        <span>vol {s ? compact(s.volume.m5) : '—'}</span>
      </div>
      {(c.riskScore !== null || c.signalScore !== null) && (
        <div className="mt-1 flex flex-wrap gap-1">
          {c.riskVerdict && <Badge tone={c.riskVerdict === 'PASS' ? 'signal' : c.riskVerdict === 'REVIEW' ? 'warn' : 'risk'}>r{c.riskScore}</Badge>}
          {c.signalScore !== null && <Badge tone="size">s{c.signalScore}</Badge>}
          {c.stage === 'TRADE_PROPOSED' && <Badge tone="warn">await</Badge>}
          {c.stage === 'RECONCILIATION_REQUIRED' && <Badge tone="warn">reconcile</Badge>}
        </div>
      )}
    </button>
  );
}

function RejectChip({ c }: { c: Candidate }) {
  const { openCandidate } = useTerminal();
  return (
    <button onClick={() => openCandidate(c.id)} className={cn('max-w-[260px] shrink-0 rounded-[4px] border border-ink-700 bg-ink-900/60 px-2 py-1 text-left hover:border-ink-500')}>
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[11px] font-semibold text-ink-200">${c.pool.token.symbol}</span>
        <Badge tone={STAGE_TONE[c.stage] ?? 'neutral'}>{c.stage.toLowerCase()}</Badge>
      </div>
      <div className="mt-0.5 truncate font-mono text-[10px] text-ink-500">{c.stageReason}</div>
    </button>
  );
}
