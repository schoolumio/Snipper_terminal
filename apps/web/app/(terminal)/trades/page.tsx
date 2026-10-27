'use client';

import type { Trade } from '@sniper/core/types';
import { STRATEGY_IDS } from '@sniper/core/config';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { Empty, Panel } from '@/components/ui/panel';
import { api } from '@/lib/api';
import { dateTime, duration, pct, price, signClass, toNum, usd } from '@/lib/format';
import { useTerminal } from '@/lib/terminal-store';

const EXIT_REASONS = ['take_profit', 'stop_loss', 'trailing_stop', 'break_even_stop', 'time_stop', 'momentum_reversal', 'liquidity_deterioration', 'manual', 'emergency', 'written_off'];
const PAGE = 50;

export default function TradesPage() {
  const { openPosition, state, viewMode } = useTerminal();
  const [mode, setMode] = useState<string>(viewMode);
  const [symbol, setSymbol] = useState('');
  const [strategy, setStrategy] = useState('');
  const [exitReason, setExitReason] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<{ rows: Trade[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closedCount = state.performance?.[mode === 'live' ? 'live' : 'paper'].trades ?? 0;

  useEffect(() => {
    const qs = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (mode) qs.set('mode', mode);
    if (symbol) qs.set('symbol', symbol.replace(/^\$/, ''));
    if (strategy) qs.set('strategy', strategy);
    if (exitReason) qs.set('exitReason', exitReason);
    if (from) qs.set('from', String(new Date(from).getTime()));
    if (to) qs.set('to', String(new Date(to).getTime() + 86_400_000));
    const ctrl = new AbortController();
    api<{ rows: Trade[]; total: number }>(`/api/trades?${qs}`, { signal: ctrl.signal })
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => !ctrl.signal.aborted && setError(e instanceof Error ? e.message : String(e)));
    return () => ctrl.abort();
  }, [mode, symbol, strategy, exitReason, from, to, offset, closedCount]);

  const rows = data?.rows ?? [];
  const net = rows.reduce((a, t) => a + toNum(t.netPnl), 0);
  const fees = rows.reduce((a, t) => a + toNum(t.fees), 0);

  return (
    <Panel index="T" title="Trade history" accent="var(--color-equity)" right={<span className="num text-[10px] text-ink-400">{data?.total ?? 0} trades</span>}>
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-700/60 px-3 py-2">
        <Select value={mode} onChange={(e) => { setMode(e.target.value); setOffset(0); }} aria-label="mode">
          <option value="paper">paper</option>
          <option value="live">live</option>
          <option value="">all modes</option>
        </Select>
        <Input value={symbol} onChange={(e) => { setSymbol(e.target.value); setOffset(0); }} placeholder="symbol / address" className="w-44" />
        <Select value={strategy} onChange={(e) => { setStrategy(e.target.value); setOffset(0); }} aria-label="strategy">
          <option value="">all strategies</option>
          {STRATEGY_IDS.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </Select>
        <Select value={exitReason} onChange={(e) => { setExitReason(e.target.value); setOffset(0); }} aria-label="exit reason">
          <option value="">all exit reasons</option>
          {EXIT_REASONS.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </Select>
        <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-36" aria-label="from" />
        <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-36" aria-label="to" />
        <span className="num ml-auto text-[11px] text-ink-400">
          page net <span className={signClass(net)}>{usd(net, { sign: true })}</span> · fees {usd(fees)}
        </span>
      </div>
      {error && <div className="px-3 py-2 font-mono text-[11px] text-down">{error}</div>}
      {rows.length === 0 ? (
        <Empty>{data ? 'no closed trades match these filters' : 'loading…'}</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px] font-mono text-[11.5px]">
            <thead className="sticky top-0 bg-ink-850 text-left">
              <tr className="label">
                {['entry', 'exit', 'token', 'strategy', 'entry px', 'exit px', 'size', 'gross', 'fees', 'net', 'return', 'held', 'exit reason', 'tx'].map((h) => (
                  <th key={h} className="whitespace-nowrap px-3 py-2 font-normal">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} onClick={() => openPosition(t.positionId)} className="cursor-pointer border-t border-ink-800 hover:bg-ink-800/50">
                  <td className="whitespace-nowrap px-3 py-1.5 text-ink-400">{dateTime(t.entryAt)}</td>
                  <td className="whitespace-nowrap px-3 text-ink-400">{dateTime(t.exitAt)}</td>
                  <td className="px-3 font-semibold text-ink-100">
                    ${t.symbol} {t.mode === 'live' ? <Badge tone="live">live</Badge> : null}
                  </td>
                  <td className="px-3 text-ink-300">{t.strategy}</td>
                  <td className="px-3">{price(t.entryPrice)}</td>
                  <td className="px-3">{price(t.exitPrice)}</td>
                  <td className="px-3">{usd(t.size)}</td>
                  <td className={`px-3 ${signClass(t.grossPnl)}`}>{usd(t.grossPnl, { sign: true })}</td>
                  <td className="px-3 text-ink-400">{usd(t.fees)}</td>
                  <td className={`px-3 ${signClass(t.netPnl)}`}>{usd(t.netPnl, { sign: true })}</td>
                  <td className={`px-3 ${signClass(t.returnPct)}`}>{pct(t.returnPct, { sign: true })}</td>
                  <td className="px-3 text-ink-400">{duration(t.holdSec)}</td>
                  <td className="px-3">
                    <Badge tone={t.exitReason === 'take_profit' ? 'up' : t.exitReason.includes('stop') ? 'exit' : t.exitReason === 'written_off' ? 'down' : 'neutral'}>{t.exitReason.replace(/_/g, ' ')}</Badge>
                  </td>
                  <td className="px-3">
                    <Badge tone={t.txStatus === 'confirmed' ? 'equity' : 'warn'}>{t.txStatus}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex items-center justify-end gap-2 border-t border-ink-700/60 px-3 py-2">
        <Button size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
          prev
        </Button>
        <span className="num text-[11px] text-ink-400">
          {data?.total ? `${offset + 1}–${Math.min(offset + PAGE, data.total)} of ${data.total}` : '0'}
        </span>
        <Button size="sm" disabled={!data || offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>
          next
        </Button>
      </div>
    </Panel>
  );
}
