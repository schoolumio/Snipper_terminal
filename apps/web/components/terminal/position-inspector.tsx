'use client';

import type { Position } from '@sniper/core/types';
import { ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, Panel } from '@/components/ui/panel';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/sheet';
import { api } from '@/lib/api';
import { age, pct, price, short, signClass, toNum, usd } from '@/lib/format';
import { useNow, useTerminal } from '@/lib/terminal-store';
import { cn } from '@/lib/utils';

export function PositionInspector() {
  const { state, viewMode } = useTerminal();
  const open = state.positions.filter((p) => p.mode === viewMode && ['open', 'exit_pending', 'reconciliation_required'].includes(p.status));
  const recent = state.positions.filter((p) => p.mode === viewMode && p.status === 'closed').sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
  const [sel, setSel] = useState<string | null>(null);
  const current = open.find((p) => p.id === sel) ?? open[0] ?? null;
  return (
    <Panel index="03" title="Trade inspector · entry vs exit" accent="var(--color-exec)" right={<span className="num text-[10px] text-ink-400">{open.length} open</span>}>
      {open.length > 1 && (
        <div className="flex gap-1 overflow-x-auto border-b border-ink-700/60 px-3 py-1.5">
          {open.map((p) => (
            <button key={p.id} onClick={() => setSel(p.id)} className={cn('shrink-0 rounded-[3px] border px-2 py-0.5 font-mono text-[11px]', current?.id === p.id ? 'border-exec/60 bg-exec/10 text-exec' : 'border-ink-700 text-ink-300 hover:border-ink-500')}>
              ${p.symbol} <span className={signClass(p.lastMark?.unrealizedPnl)}>{pct(p.lastMark?.unrealizedPnlPct ?? null, { sign: true, dp: 1 })}</span>
            </button>
          ))}
        </div>
      )}
      {current ? <PositionDetail p={current} /> : <LastClosed p={recent[0] ?? null} />}
    </Panel>
  );
}

function LastClosed({ p }: { p: Position | null }) {
  const { openPosition } = useTerminal();
  if (!p) return <Empty>no open positions — the executor has not entered a trade in this mode yet</Empty>;
  return (
    <div className="p-3">
      <div className="label mb-2">no open positions · last closed</div>
      <button onClick={() => openPosition(p.id)} className="flex w-full items-center justify-between rounded-[4px] border border-ink-700 px-3 py-2 text-left hover:border-ink-500">
        <span className="font-mono text-sm font-semibold">${p.symbol}</span>
        <span className="font-mono text-[11px] text-ink-400">{p.exitReason}</span>
        <span className={cn('num text-sm', signClass(p.realizedPnl))}>{usd(p.realizedPnl, { sign: true })}</span>
      </button>
    </div>
  );
}

function PositionDetail({ p }: { p: Position }) {
  const { isAdmin, openPosition, state } = useTerminal();
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'close' | 'writeoff' | null>(null);
  const [typed, setTyped] = useState('');
  const m = p.lastMark;
  const qty = toNum(p.qty);
  const costPer = qty > 0 ? toNum(p.openCostBasis) / qty : 0;
  const valuePer = m?.liquidationValue && qty > 0 ? toNum(m.liquidationValue) / qty : null;
  const stop = toNum(p.stopPricePerToken);
  const tps = p.exitPolicy.takeProfit.map((t) => costPer * (1 + toNum(t.gainPct) / 100));
  const estExit = m?.liquidationValue ? toNum(m.markValue) - toNum(m.liquidationValue) : null;
  const simulated = p.mode === 'paper' || state.status?.simulatedMarket;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      setConfirm(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const rows: [string, React.ReactNode][] = [
    ['entry fill', price(p.entryFillPrice)],
    ['exit quote', m?.liquidationValue ? `${usd(m.liquidationValue)} (${price(valuePer)}/tk)` : <span className="text-warn">{m?.quoteError ?? 'pending'}</span>],
    ['size', `${usd(p.costBasis)} · ${Number(p.qty).toLocaleString('en-US', { maximumFractionDigits: 0 })} tk`],
    ['entry fees', usd(p.entryFeesQuote)],
    ['est. exit cost', estExit === null ? '—' : `${usd(estExit)} (impact ${pct(m?.priceImpactPct)})`],
    ['stop', `${price(stop)} ${p.trailingActive ? '· trailing' : p.breakEvenArmed ? '· break-even' : ''}`],
    ['targets', p.exitPolicy.takeProfit.map((t, i) => `${i < p.tpLevelsHit ? '✓' : ''}+${t.gainPct}%→${Math.round(toNum(t.sellFraction) * 100)}%`).join('  ')],
    ['held', `${age(now - p.openedAt)} / max ${Math.round(p.exitPolicy.maxHoldSec / 60)}m`],
    ['risk score', String(p.riskScore)],
    ['pool', short(p.poolAddress, 5)],
  ];

  return (
    <div className="p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-xl font-semibold tracking-tight">${p.symbol}</span>
            <Badge tone="exec">long</Badge>
            <Badge tone={p.status === 'open' ? 'equity' : 'warn'}>{p.status.replace('_', ' ')}</Badge>
            {p.unsellable && <Badge tone="risk">unsellable</Badge>}
            {simulated && <Badge tone="warn">simulated</Badge>}
          </div>
          <div className="mt-0.5 font-mono text-[10.5px] text-ink-500">
            {p.strategy}@{p.strategyVersion} · {p.chain} · exit policy v{p.exitPolicy.version}
          </div>
        </div>
        <div className="text-right">
          <div className={cn('num text-2xl leading-none', signClass(m?.unrealizedPnl))}>{m?.unrealizedPnlPct ? pct(m.unrealizedPnlPct, { sign: true }) : '—'}</div>
          <div className={cn('num mt-1 text-[11px]', signClass(m?.unrealizedPnl))}>{m?.unrealizedPnl ? `${usd(m.unrealizedPnl, { sign: true })} unrealized` : 'awaiting quote'}</div>
        </div>
      </div>

      <RangeBar stop={stop} entry={costPer} current={valuePer} targets={tps} high={toNum(p.highWaterValuePerToken)} />

      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-3 border-b border-ink-800 py-1">
            <dt className="label">{k}</dt>
            <dd className="num truncate text-[11.5px] text-ink-200">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-2.5 space-y-1 font-mono text-[11px] leading-relaxed">
        <div>
          <span className="text-scan">reason: </span>
          <span className="text-ink-300">{p.entryRationale}</span>
        </div>
        <div>
          <span className="text-exit">exit: </span>
          <span className="text-ink-300">{p.exitReason ? `${p.exitReason} — ${p.exitRationale ?? ''}` : 'no exit condition met'}</span>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={() => openPosition(p.id)}>
          audit trail <ExternalLink size={11} />
        </Button>
        {isAdmin && (
          <>
            <Button size="sm" variant="danger" disabled={busy || p.status !== 'open'} onClick={() => setConfirm('close')}>
              close position
            </Button>
            {p.unsellable && (
              <Button size="sm" variant="default" disabled={busy} onClick={() => setConfirm('writeoff')}>
                write off
              </Button>
            )}
          </>
        )}
        {err && <span className="font-mono text-[11px] text-down">{err}</span>}
      </div>
      <Modal open={confirm !== null} onOpenChange={(o) => { if (!o) { setConfirm(null); setTyped(''); } }} title={confirm === 'close' ? `Close $${p.symbol}?` : `Write off $${p.symbol}?`}>
        {confirm === 'close' ? (
          <div className="space-y-3 text-xs text-ink-300">
            <p>Submits a market sell for the full remaining quantity through the executor. Expected proceeds ≈ {m?.liquidationValue ? usd(m.liquidationValue) : 'unknown'}; the actual fill may differ.</p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirm(null)}>cancel</Button>
              <Button variant="danger" disabled={busy} onClick={() => run(() => api(`/api/positions/${p.id}/close`, { method: 'POST' }))}>sell now</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3 text-xs text-ink-300">
            <p>Marks the remaining cost basis ({usd(p.openCostBasis)}) as a realized loss. Use only for positions that cannot be sold. Type <span className="num text-ink-100">WRITE OFF</span>.</p>
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="WRITE OFF" />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirm(null)}>cancel</Button>
              <Button variant="danger" disabled={busy || typed !== 'WRITE OFF'} onClick={() => run(() => api(`/api/positions/${p.id}/write-off`, { method: 'POST', body: { confirm: 'WRITE OFF' } }))}>write off</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

/** Stop ← entry → targets, with the executable value marker. */
function RangeBar({ stop, entry, current, targets, high }: { stop: number; entry: number; current: number | null; targets: number[]; high: number }) {
  const lo = Math.min(stop, current ?? stop) * 0.98;
  const hi = Math.max(...targets, current ?? entry, high) * 1.02;
  const x = (v: number) => `${Math.max(0, Math.min(100, ((v - lo) / (hi - lo || 1)) * 100))}%`;
  return (
    <div className="mt-4">
      <div className="relative h-7">
        <div className="absolute inset-x-0 top-3 h-[3px] rounded-full bg-ink-700" />
        <div className="absolute top-3 h-[3px] rounded-l-full bg-down/50" style={{ left: 0, width: x(entry) }} />
        <div className="absolute top-3 h-[3px] bg-up/40" style={{ left: x(entry), right: 0 }} />
        <Marker at={x(stop)} color="var(--color-down)" label="stop" />
        <Marker at={x(entry)} color="var(--color-ink-200)" label="cost" />
        {targets.map((t, i) => (
          <Marker key={i} at={x(t)} color="var(--color-up)" label={`tp${i + 1}`} />
        ))}
        {high > 0 && <Marker at={x(high)} color="var(--color-ink-400)" label="high" dashed />}
        {current !== null && (
          <div className="absolute top-[5px] -translate-x-1/2" style={{ left: x(current) }}>
            <div className="h-4 w-4 rounded-full border-2 border-exec bg-ink-900 shadow-[0_0_12px_var(--color-exec)]" />
          </div>
        )}
      </div>
      <div className="num mt-0.5 flex justify-between text-[9.5px] text-ink-500">
        <span>stop {price(stop)}</span>
        <span>executable value / token {current === null ? '—' : price(current)}</span>
        <span>tp {price(targets[targets.length - 1] ?? 0)}</span>
      </div>
    </div>
  );
}

function Marker({ at, color, label, dashed }: { at: string; color: string; label: string; dashed?: boolean }) {
  return (
    <div className="absolute top-0 -translate-x-1/2" style={{ left: at }}>
      <div className={cn('mx-auto h-[15px] w-px', dashed && 'opacity-60')} style={{ background: color }} />
      <div className="num -mt-0.5 hidden text-[8.5px] uppercase sm:block" style={{ color }}>
        {label}
      </div>
    </div>
  );
}
