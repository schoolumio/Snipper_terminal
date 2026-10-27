'use client';

import type { TradingMode } from '@sniper/core/types';
import { Stat } from '@/components/ui/panel';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { pct, signClass, toNum, usd } from '@/lib/format';
import { useTerminal } from '@/lib/terminal-store';
import { cn } from '@/lib/utils';

export function KpiStrip() {
  const { state, viewMode, setViewMode } = useTerminal();
  const p = state.performance?.[viewMode];
  const hasLive = (state.performance?.live.startingEquity ?? '0') !== '0';
  const wr = p?.winRate;
  return (
    <section className="panel grid grid-cols-2 gap-x-6 gap-y-3.5 px-4 py-3.5 sm:grid-cols-4 lg:grid-cols-[minmax(240px,1.3fr)_repeat(4,minmax(0,1fr))] min-[2100px]:grid-cols-[minmax(240px,1.3fr)_repeat(8,minmax(0,1fr))]">
      <div className="col-span-2 sm:col-span-4 lg:col-span-1 lg:row-span-2 lg:border-r lg:border-ink-700/60 lg:pr-5 min-[2100px]:row-span-1">
        <div className="flex items-center justify-between gap-2">
          <span className="label">equity · {viewMode}</span>
          <Tabs value={viewMode} onValueChange={(v) => setViewMode(v as TradingMode)}>
            <TabsList>
              <TabsTrigger value="paper">paper</TabsTrigger>
              <TabsTrigger value="live" disabled={!hasLive} title={hasLive ? '' : 'No live ledger yet'}>
                live
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        <div className="num mt-1.5 text-[28px] font-medium leading-none tracking-tight text-ink-100">{p ? usd(p.equity) : '—'}</div>
        <div className="num mt-1.5 text-[11px] text-ink-400">
          net <span className={signClass(p?.netPnl)}>{p ? usd(p.netPnl, { sign: true }) : '—'}</span> since start {p ? usd(p.startingEquity) : ''}
          {p && p.unvaluedPositions > 0 && <span className="ml-2 text-warn">· {p.unvaluedPositions} unvalued</span>}
        </div>
      </div>
      <Stat label="available" value={p ? usd(p.available) : '—'} sub={p ? `reserved ${usd(p.reserved)}` : undefined} />
      <Stat label="realized p&l" value={p ? usd(p.realizedPnl, { sign: true }) : '—'} valueClassName={signClass(p?.realizedPnl)} sub={p ? `fees ${usd(p.feesPaid)}` : undefined} />
      <Stat label="unrealized" value={p ? usd(p.unrealizedPnl, { sign: true }) : '—'} valueClassName={signClass(p?.unrealizedPnl)} sub={p ? `${p.openPositions} open · ${usd(p.openExposure)}` : undefined} />
      <Stat label="daily p&l" value={p ? usd(p.dailyPnl, { sign: true }) : '—'} valueClassName={signClass(p?.dailyPnl)} sub="UTC day" />
      <Stat label="trades" value={p ? p.trades : '—'} sub={p?.avgHoldSec ? `avg hold ${Math.round(p.avgHoldSec / 60)}m` : 'closed round trips'} />
      <Stat label="wins / losses" value={p ? <><span className="text-up">{p.wins}</span><span className="text-ink-500"> / </span><span className="text-down">{p.losses}</span></> : '—'} sub={p?.profitFactor ? `PF ${p.profitFactor.toFixed(2)}` : 'profit factor —'} />
      <Stat label="win rate" value={wr === null || wr === undefined ? '—' : `${(wr * 100).toFixed(1)}%`} sub={p?.avgWin ? `avg ${usd(p.avgWin)} / ${usd(p.avgLoss)}` : undefined} />
      <Stat
        label="drawdown"
        value={p ? pct(p.currentDrawdownPct) : '—'}
        valueClassName={cn(toNum(p?.currentDrawdownPct) > 5 ? 'text-down' : toNum(p?.currentDrawdownPct) > 0 ? 'text-warn' : 'text-ink-100')}
        sub={p ? `max ${pct(p.maxDrawdownPct)}` : undefined}
      />
    </section>
  );
}
