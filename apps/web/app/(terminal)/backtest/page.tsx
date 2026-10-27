'use client';

import type { BacktestRunSummary, Trade } from '@sniper/core/types';
import { useCallback, useEffect, useState } from 'react';
import { EquityChart } from '@/components/terminal/equity-chart';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Empty, Panel, Stat } from '@/components/ui/panel';
import { api } from '@/lib/api';
import { dateTime, duration, pct, signClass, usd } from '@/lib/format';
import { useTerminal } from '@/lib/terminal-store';
import { cn } from '@/lib/utils';

export default function BacktestPage() {
  const { isAdmin, state } = useTerminal();
  const [seed, setSeed] = useState('1');
  const [hours, setHours] = useState('2');
  const [equity, setEquity] = useState('1000');
  const [list, setList] = useState<{ running: boolean; runs: BacktestRunSummary[] } | null>(null);
  const [sel, setSel] = useState<{ run: BacktestRunSummary; trades: Trade[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const l = await api<{ running: boolean; runs: BacktestRunSummary[] }>('/api/backtests');
    setList(l);
    return l;
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!list?.running) return;
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [list?.running, load]);

  const start = async () => {
    setErr(null);
    try {
      await api('/api/backtests', { method: 'POST', body: { seed: Number(seed), durationSec: Math.round(Number(hours) * 3600), startingEquity: equity } });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  const open = async (id: string) => setSel(await api(`/api/backtests/${id}`));
  const s = sel?.run.stats;

  return (
    <div className="grid grid-cols-1 gap-2.5 xl:grid-cols-[360px_minmax(0,1fr)]">
      <div className="flex flex-col gap-2.5">
        <Panel index="B1" title="Run a backtest" accent="var(--color-size)" bodyClassName="p-3 space-y-3">
          <p className="font-mono text-[11px] leading-relaxed text-ink-400">
            Replays the <span className="text-ink-200">full production pipeline</span> in virtual time against the <span className="text-warn">synthetic simulated market</span> using the current config (v{state.status?.configVersion}). Fills settle after latency against a moving AMM pool, with fees and failures. No look-ahead: the engine only observes data produced up to each tick. Results describe the simulator, not real markets.
          </p>
          <div className="grid grid-cols-3 gap-2">
            <label className="space-y-1">
              <span className="label">seed</span>
              <Input value={seed} onChange={(e) => setSeed(e.target.value.replace(/\D/g, ''))} />
            </label>
            <label className="space-y-1">
              <span className="label">hours</span>
              <Input value={hours} onChange={(e) => setHours(e.target.value.replace(/[^\d.]/g, ''))} />
            </label>
            <label className="space-y-1">
              <span className="label">equity</span>
              <Input value={equity} onChange={(e) => setEquity(e.target.value.replace(/[^\d.]/g, ''))} />
            </label>
          </div>
          {err && <div className="font-mono text-[11px] text-down">{err}</div>}
          <Button variant="primary" className="w-full" disabled={!isAdmin || list?.running || !seed || Number(hours) < 0.084 || Number(hours) > 6} onClick={start}>
            {list?.running ? 'running…' : isAdmin ? 'start backtest' : 'admin only'}
          </Button>
        </Panel>
        <Panel index="B2" title="Runs" bodyClassName="max-h-[60vh] overflow-y-auto">
          {!list?.runs.length ? (
            <Empty>no backtests yet</Empty>
          ) : (
            list.runs.map((r) => (
              <button key={r.id} onClick={() => void open(r.id)} className={cn('flex w-full items-center justify-between gap-2 border-b border-ink-800 px-3 py-2 text-left hover:bg-ink-800/50', sel?.run.id === r.id && 'bg-ink-800/60')}>
                <div>
                  <div className="font-mono text-[11.5px] text-ink-200">
                    seed {r.seed} · {duration(r.durationSec)}
                  </div>
                  <div className="font-mono text-[10px] text-ink-500">{dateTime(r.createdAt)} · cfg v{r.configVersion}</div>
                </div>
                {r.stats ? <span className={cn('num text-[12px]', signClass(r.stats.netPnl))}>{usd(r.stats.netPnl, { sign: true })}</span> : <Badge tone={r.status === 'failed' ? 'down' : 'warn'}>{r.status}</Badge>}
              </button>
            ))
          )}
        </Panel>
      </div>
      <Panel index="B3" title={sel ? `Result · seed ${sel.run.seed}` : 'Result'} accent="var(--color-equity)" right={sel && <Badge tone="warn">synthetic data</Badge>} bodyClassName="p-3">
        {!sel ? (
          <Empty>select a run</Empty>
        ) : (
          <>
            {sel.run.error && <div className="mb-2 font-mono text-[11px] text-down">{sel.run.error}</div>}
            {s && (
              <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-8">
                <Stat label="net p&l" value={usd(s.netPnl, { sign: true })} valueClassName={signClass(s.netPnl)} />
                <Stat label="end equity" value={usd(s.equity)} />
                <Stat label="trades" value={s.trades} sub={`${s.wins}W / ${s.losses}L`} />
                <Stat label="win rate" value={s.winRate === null ? '—' : `${(s.winRate * 100).toFixed(1)}%`} />
                <Stat label="profit factor" value={s.profitFactor?.toFixed(2) ?? '—'} />
                <Stat label="max dd" value={pct(s.maxDrawdownPct)} />
                <Stat label="fees" value={usd(s.feesPaid)} />
                <Stat label="failed tx" value={s.failedTxRate === null ? '—' : pct(s.failedTxRate * 100)} />
              </div>
            )}
            <EquityChart points={sel.run.equityCurve} startingEquity={s?.startingEquity} height={260} />
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[700px] font-mono text-[11px]">
                <thead className="label text-left">
                  <tr>
                    {['token', 'strategy', 'size', 'net', 'return', 'held', 'exit'].map((h) => (
                      <th key={h} className="px-2 py-1 font-normal">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sel.trades.map((t) => (
                    <tr key={t.id} className="border-t border-ink-800">
                      <td className="px-2 py-1">${t.symbol}</td>
                      <td className="px-2 text-ink-400">{t.strategy}</td>
                      <td className="px-2">{usd(t.size)}</td>
                      <td className={`px-2 ${signClass(t.netPnl)}`}>{usd(t.netPnl, { sign: true })}</td>
                      <td className={`px-2 ${signClass(t.returnPct)}`}>{pct(t.returnPct, { sign: true })}</td>
                      <td className="px-2 text-ink-400">{duration(t.holdSec)}</td>
                      <td className="px-2 text-ink-400">{t.exitReason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 font-mono text-[10px] text-ink-500">{sel.run.notes} Past simulated performance is not evidence of future or real-world profitability.</p>
          </>
        )}
      </Panel>
    </div>
  );
}
