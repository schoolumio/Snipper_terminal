'use client';

import { usd, pct, signClass, toNum } from '@/lib/format';
import { useTerminal } from '@/lib/terminal-store';
import { cn } from '@/lib/utils';

export function MetricTiles() {
  const { state, viewMode } = useTerminal();
  const c = state.counters;
  const p = state.performance?.[viewMode];
  const open = state.positions.filter((x) => x.mode === viewMode && (x.status === 'open' || x.status === 'exit_pending'));
  const avgSize = open.length ? open.reduce((a, x) => a + toNum(x.costBasis), 0) / open.length : null;
  const liqExposure = open.reduce((a, x) => {
    const l = toNum(x.lastMark?.liquidity ?? x.entryLiquidity);
    return l > 0 ? a + (toNum(x.openCostBasis) / l) * 100 : a;
  }, 0);
  const tiles: { label: string; value: string; sub: string; color: string; valueClass?: string }[] = [
    { label: 'filtered', value: String(c?.rejected ?? '—'), sub: `${c?.screened ?? 0} screened · session`, color: 'var(--color-risk)' },
    { label: 'approved', value: String(c?.approved ?? '—'), sub: `${c?.proposed ?? 0} proposed · session`, color: 'var(--color-signal)' },
    { label: 'active', value: String(open.length), sub: `${state.approvals.length} awaiting approval`, color: 'var(--color-exec)' },
    { label: 'avg position', value: avgSize === null ? '—' : usd(avgSize), sub: p ? `${((toNum(p.openExposure) / Math.max(1, toNum(p.equity))) * 100).toFixed(1)}% of equity` : '', color: 'var(--color-size)' },
    { label: 'liq. exposure', value: open.length ? pct(liqExposure, { dp: 2 }) : '—', sub: 'share of pool liquidity', color: 'var(--color-scan)' },
    { label: 'equity', value: p ? usd(p.equity) : '—', sub: viewMode, color: 'var(--color-equity)' },
    { label: 'daily p&l', value: p ? usd(p.dailyPnl, { sign: true }) : '—', sub: 'mark-to-liquidation', color: 'var(--color-equity)', valueClass: signClass(p?.dailyPnl) },
    { label: 'avg slippage', value: c?.avgSlippagePct ? pct(c.avgSlippagePct) : p?.avgSlippagePct ? pct(p.avgSlippagePct) : '—', sub: 'fill vs quote (+ = worse)', color: 'var(--color-exit)' },
    { label: 'tx failures', value: String(c?.txFailures ?? '—'), sub: `of ${c?.txSubmitted ?? 0} submitted`, color: 'var(--color-down)', valueClass: (c?.txFailures ?? 0) > 0 ? 'text-down' : undefined },
    { label: 'expired', value: String(c?.expired ?? '—'), sub: `${c?.skipped ?? 0} no-signal evals · session`, color: 'var(--color-orch)' },
  ];
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
      {tiles.map((t) => (
        <div key={t.label} className="panel overflow-hidden px-3 py-2.5">
          <div className="absolute inset-x-0 top-0 h-px" style={{ background: `linear-gradient(90deg, ${t.color}, transparent 70%)` }} />
          <div className="label">{t.label}</div>
          <div className={cn('num mt-1 truncate text-[17px] leading-none text-ink-100', t.valueClass)}>{t.value}</div>
          <div className="num mt-1 truncate text-[10px] text-ink-500">{t.sub}</div>
        </div>
      ))}
    </div>
  );
}
