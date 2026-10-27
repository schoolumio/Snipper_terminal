'use client';

import { AgentRail } from '@/components/terminal/agent-rail';
import { AlertsPanel } from '@/components/terminal/alerts-panel';
import { EquityChart } from '@/components/terminal/equity-chart';
import { KpiStrip } from '@/components/terminal/kpi-strip';
import { LiveLog } from '@/components/terminal/live-log';
import { MetricTiles } from '@/components/terminal/metric-tiles';
import { PipelineBoard } from '@/components/terminal/pipeline-board';
import { PositionInspector } from '@/components/terminal/position-inspector';
import { Panel } from '@/components/ui/panel';
import { pct, signClass, usd } from '@/lib/format';
import { useTerminal } from '@/lib/terminal-store';

export default function TerminalPage() {
  const { state, viewMode } = useTerminal();
  const p = state.performance?.[viewMode];
  const series = state.equity[viewMode];
  return (
    <div className="grid grid-cols-1 gap-2.5 xl:grid-cols-[272px_minmax(0,1fr)_380px]">
      <aside className="order-2 min-w-0 xl:order-1">
        <AgentRail />
      </aside>
      <div className="order-1 flex min-w-0 flex-col gap-2.5 xl:order-2">
        <KpiStrip />
        <PipelineBoard />
        <MetricTiles />
        <div className="grid grid-cols-1 gap-2.5 2xl:grid-cols-2">
          <PositionInspector />
          <Panel
            index="04"
            title={`Equity curve · ${viewMode}`}
            accent="var(--color-equity)"
            right={
              p && (
                <span className="num text-[10px] text-ink-400">
                  start {usd(p.startingEquity)} → <span className={signClass(p.netPnl)}>{usd(p.equity)}</span> · max dd {pct(p.maxDrawdownPct)}
                </span>
              )
            }
            bodyClassName="p-2"
          >
            <EquityChart points={series} startingEquity={p?.startingEquity} height={260} />
            <div className="num px-1 pt-1 text-[9.5px] text-ink-500">recorded snapshots only · equity = cash + executable liquidation value of open positions · lower pane: drawdown</div>
          </Panel>
        </div>
      </div>
      <aside className="order-3 flex min-w-0 flex-col gap-2.5 xl:sticky xl:top-[60px] xl:h-[calc(100vh-72px)]">
        <LiveLog className="min-h-[420px] flex-1" />
        <AlertsPanel />
      </aside>
    </div>
  );
}
