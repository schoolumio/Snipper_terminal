'use client';

import { AreaSeries, ColorType, createChart, HistogramSeries, LineStyle, type IChartApi, type ISeriesApi, type IPriceLine, type UTCTimestamp } from 'lightweight-charts';
import { useEffect, useRef } from 'react';
import { Empty } from '@/components/ui/panel';

export interface EquityPoint {
  ts: number;
  equity: string;
  drawdownPct?: string;
}

/** Equity curve with a drawdown pane. Plots only recorded snapshots — never interpolated or fabricated. */
export function EquityChart({ points, startingEquity, height = 220 }: { points: EquityPoint[]; startingEquity?: string; height?: number }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const area = useRef<ISeriesApi<'Area'> | null>(null);
  const dd = useRef<ISeriesApi<'Histogram'> | null>(null);
  const startLine = useRef<IPriceLine | null>(null);

  useEffect(() => {
    if (!el.current) return;
    const css = getComputedStyle(document.documentElement);
    const v = (n: string, f: string) => css.getPropertyValue(n).trim() || f;
    const c = createChart(el.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: v('--color-ink-400', '#5b6779'), fontFamily: v('--font-mono', 'monospace'), fontSize: 10, attributionLogo: false, panes: { separatorColor: v('--color-ink-700', '#1a2230') } },
      grid: { vertLines: { color: 'rgba(255,255,255,0.03)' }, horzLines: { color: 'rgba(255,255,255,0.04)' } },
      rightPriceScale: { borderColor: v('--color-ink-700', '#1a2230') },
      timeScale: { borderColor: v('--color-ink-700', '#1a2230'), timeVisible: true, secondsVisible: false },
      crosshair: { horzLine: { color: v('--color-ink-500', '#3a4659') }, vertLine: { color: v('--color-ink-500', '#3a4659') } },
    });
    const green = v('--color-equity', '#3ddc97');
    area.current = c.addSeries(AreaSeries, { lineColor: green, topColor: 'rgba(61,220,151,0.22)', bottomColor: 'rgba(61,220,151,0)', lineWidth: 2, priceFormat: { type: 'price', precision: 2, minMove: 0.01 } });
    dd.current = c.addSeries(HistogramSeries, { color: 'rgba(240,71,106,0.55)', priceFormat: { type: 'percent', precision: 2, minMove: 0.01 } }, 1);
    try {
      c.panes()[1]?.setHeight(Math.round(height * 0.22));
    } catch {
      /* older API */
    }
    chart.current = c;
    return () => {
      c.remove();
      chart.current = null;
      startLine.current = null;
    };
  }, [height]);

  useEffect(() => {
    if (!area.current || !dd.current) return;
    const bySec = new Map<number, EquityPoint>();
    for (const p of points) bySec.set(Math.floor(p.ts / 1000), p);
    const sorted = [...bySec.entries()].sort((a, b) => a[0] - b[0]);
    area.current.setData(sorted.map(([t, p]) => ({ time: t as UTCTimestamp, value: Number(p.equity) })));
    dd.current.setData(sorted.map(([t, p]) => ({ time: t as UTCTimestamp, value: -Number(p.drawdownPct ?? 0) })));
    if (startingEquity) {
      if (startLine.current) area.current.removePriceLine(startLine.current);
      startLine.current = area.current.createPriceLine({ price: Number(startingEquity), color: 'rgba(184,192,204,0.45)', lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true, title: 'start' });
    }
    chart.current?.timeScale().fitContent();
  }, [points, startingEquity]);

  return (
    <div className="relative" style={{ height }}>
      <div ref={el} className="absolute inset-0" />
      {points.length < 2 && (
        <div className="absolute inset-0">
          <Empty>equity curve appears after the first recorded snapshots</Empty>
        </div>
      )}
    </div>
  );
}
