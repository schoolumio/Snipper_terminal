'use client';

import type { AgentId, AgentStatus, AuditEvent, Candidate, ChainTransaction, Order, Position, PositionEvent, RiskAssessment, SizingDecision, StrategySignal, TradeProposal } from '@sniper/core/types';
import { useEffect, useState, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Empty } from '@/components/ui/panel';
import { Sheet } from '@/components/ui/sheet';
import { api } from '@/lib/api';
import { age, clock, compact, dateTime, pct, price, short, signClass, usd } from '@/lib/format';
import { useTerminal } from '@/lib/terminal-store';
import { cn } from '@/lib/utils';
import { AGENT_META, RESULT_TONE, STAGE_TONE } from './meta';

function useFetch<T>(url: string | null, deps: unknown[] = []): { data: T | null; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!url) {
      setData(null);
      return;
    }
    const ctrl = new AbortController();
    setError(null);
    api<T>(url, { signal: ctrl.signal })
      .then(setData)
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, ...deps]);
  return { data, error };
}

function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="mb-5">
      <div className="mb-2 flex items-center justify-between border-b border-ink-700 pb-1">
        <h3 className="label !text-ink-200">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

function KV({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-baseline justify-between gap-3 border-b border-ink-800 py-1">
          <dt className="label">{k}</dt>
          <dd className="num min-w-0 truncate text-right text-[11.5px] text-ink-200">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function AuditTrail({ events }: { events: AuditEvent[] }) {
  if (!events.length) return <Empty>no audit events</Empty>;
  return (
    <ol className="relative space-y-1.5 border-l border-ink-700 pl-4">
      {events.map((e) => {
        const m = AGENT_META[e.agent];
        return (
          <li key={e.id} className="relative">
            <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full border border-ink-900" style={{ background: m.color }} />
            <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
              <span className="text-ink-500">{clock(e.ts)}</span>
              <span style={{ color: m.color }}>{m.tag}</span>
              <Badge tone={RESULT_TONE[e.result]}>{e.result}</Badge>
              <span className="text-ink-100">{e.action}</span>
              {e.sizeQuote && <span className="text-ink-400">{usd(e.sizeQuote)}</span>}
              <span className="text-ink-600">#{e.seq} · cfg v{e.configVersion}</span>
            </div>
            <div className="mt-0.5 font-mono text-[11px] leading-snug text-ink-400">{e.reason}</div>
            {Object.keys(e.metrics).length > 0 && (
              <div className="mt-0.5 flex flex-wrap gap-x-3 font-mono text-[10px] text-ink-600">
                {Object.entries(e.metrics)
                  .slice(0, 10)
                  .map(([k, v]) => (
                    <span key={k}>
                      {k}=<span className="text-ink-400">{String(v)}</span>
                    </span>
                  ))}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

// ───────────────────────── agent ─────────────────────────

export function AgentSheet() {
  const { inspect, openAgent, state } = useTerminal();
  const id = inspect.agentId as AgentId | null;
  const live = state.agents.find((a) => a.id === id);
  const { data } = useFetch<{ agent: AgentStatus; events: AuditEvent[]; errors: AgentStatus['errors'] }>(id ? `/api/agents/${id}/events?limit=80` : null, [live?.lastUpdate && Math.floor(live.lastUpdate / 10_000)]);
  const m = id ? AGENT_META[id] : null;
  const a = live ?? data?.agent;
  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && openAgent(null)} title={a ? a.name : 'Agent'} subtitle={a?.role} accent={m?.color}>
      {a && (
        <>
          <Section title="status">
            <KV
              rows={[
                ['state', <Badge key="s" tone={a.state === 'error' ? 'down' : a.state === 'ok' ? 'equity' : 'neutral'}>{a.state}</Badge>],
                ['current task', a.currentTask ?? '—'],
                ['last action', a.lastAction ?? '—'],
                ['last decision', a.lastDecision ?? '—'],
                ['warning', a.warning ?? '—'],
                ['updated', dateTime(a.lastUpdate)],
                ...Object.entries(a.counters).map(([k, v]) => [k, String(v)] as [string, ReactNode]),
              ]}
            />
          </Section>
          <Section title="configuration">
            <p className="font-mono text-[11px] text-ink-400">
              This agent&apos;s thresholds live in <a className="text-exec hover:underline" href="/settings">Settings</a> (config v{state.status?.configVersion}). Hard limits from the server environment always apply on top.
            </p>
          </Section>
          <Section title={`error history (${a.errors.length})`}>
            {a.errors.length === 0 ? (
              <Empty>no errors recorded</Empty>
            ) : (
              <ul className="space-y-1 font-mono text-[11px]">
                {a.errors.map((e, i) => (
                  <li key={i} className="text-down">
                    <span className="text-ink-500">{dateTime(e.ts)}</span> {e.message}
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title="recent decisions">{data ? <AuditTrail events={data.events} /> : <Empty>loading…</Empty>}</Section>
        </>
      )}
    </Sheet>
  );
}

// ───────────────────────── token / candidate ─────────────────────────

interface TokenDetail {
  candidate: Candidate;
  assessments: RiskAssessment[];
  signals: StrategySignal[];
  proposals: TradeProposal[];
  sizing: SizingDecision[];
  orders: Order[];
  audit: AuditEvent[];
  history: { ts: number; price: string; liquidity: string; volume5m: string }[];
}

const SEV_TONE = { critical: 'risk', high: 'exit', medium: 'warn', low: 'neutral', info: 'log' } as const;

export function TokenSheet() {
  const { inspect, openCandidate, state, openPosition } = useTerminal();
  const id = inspect.candidateId;
  const live = state.candidates.find((c) => c.id === id);
  const { data, error } = useFetch<TokenDetail>(id ? `/api/tokens/${id}` : null, [live?.stage]);
  const c = live ?? data?.candidate;
  const latestRisk = data?.assessments[data.assessments.length - 1];
  const sizing = data?.sizing[data.sizing.length - 1];
  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && openCandidate(null)} title={c ? `$${c.pool.token.symbol}` : 'Token'} subtitle={c ? `${c.pool.token.name} · ${short(c.pool.token.address, 6)} · ${c.chain}` : undefined} accent={c ? `var(--color-${STAGE_TONE[c.stage] === 'risk' ? 'risk' : 'exec'})` : undefined} wide>
      {error && <div className="mb-3 font-mono text-[11px] text-down">{error}</div>}
      {c && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Badge tone={STAGE_TONE[c.stage] ?? 'neutral'} className="h-6 px-2">
              {c.stage}
            </Badge>
            <span className="font-mono text-[11px] text-ink-400">{c.stageReason}</span>
            {c.positionId && (
              <button className="ml-auto font-mono text-[11px] text-exec hover:underline" onClick={() => openPosition(c.positionId)}>
                open position →
              </button>
            )}
          </div>
          <Section title="market">
            <KV
              rows={[
                ['price', c.snapshot ? price(c.snapshot.price) : '—'],
                ['liquidity', c.snapshot ? usd(c.snapshot.liquidity) : '—'],
                ['market cap (est.)', c.snapshot?.marketCap ? usd(c.snapshot.marketCap) : 'unknown'],
                ['volume 5m / 1h', c.snapshot ? `${compact(c.snapshot.volume.m5)} / ${compact(c.snapshot.volume.h1)}` : '—'],
                ['buys / sells 5m', c.snapshot ? `${c.snapshot.txns.m5.buys} / ${c.snapshot.txns.m5.sells}` : '—'],
                ['change 1m / 5m', c.snapshot ? `${pct(c.snapshot.priceChange.m1, { sign: true })} / ${pct(c.snapshot.priceChange.m5, { sign: true })}` : '—'],
                ['holders', String(c.snapshot?.holders ?? 'unknown')],
                ['pool age', age(Date.now() - c.pool.createdAt)],
                ['scanner score', String(c.scannerScore)],
                ['data freshness', c.snapshot ? `${age(Date.now() - c.snapshot.ts)} · ${c.snapshot.source}` : '—'],
                ['pool', `${c.pool.dex} · ${short(c.pool.address, 6)}`],
                ['pair', `${c.pool.token.symbol}/${c.pool.quoteSymbol}`],
              ]}
            />
            {data && data.history.length > 2 && <Spark values={data.history.map((h) => Number(h.price))} />}
          </Section>
          <Section title="risk guard" right={latestRisk && <span className="font-mono text-[10px] text-ink-500">{latestRisk.phase} · confidence {(latestRisk.confidence * 100).toFixed(0)}%</span>}>
            {latestRisk ? (
              <>
                <div className="mb-2 flex items-center gap-2">
                  <Badge tone={latestRisk.verdict === 'PASS' ? 'signal' : latestRisk.verdict === 'REVIEW' ? 'warn' : 'risk'} className="h-6 px-2">
                    {latestRisk.verdict} · {latestRisk.riskScore}
                  </Badge>
                  <span className="font-mono text-[11px] text-ink-300">{latestRisk.summary}</span>
                </div>
                <p className="mb-2 font-mono text-[10px] text-ink-500">PASS means the configured checks found nothing disqualifying. It does not mean the token is safe.</p>
                <table className="w-full font-mono text-[11px]">
                  <tbody>
                    {latestRisk.factors.map((f, i) => (
                      <tr key={i} className="border-b border-ink-800 align-top">
                        <td className="py-1 pr-2">
                          <Badge tone={SEV_TONE[f.severity]}>{f.severity}</Badge>
                        </td>
                        <td className="py-1 pr-2 text-ink-300">
                          {f.message}
                          {f.blocking && <span className="ml-1 text-risk">[blocking]</span>}
                        </td>
                        <td className="py-1 text-right text-ink-600">{f.source}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : (
              <Empty>not yet screened</Empty>
            )}
          </Section>
          {data && data.signals.length > 0 && (
            <Section title="strategy signals">
              {data.signals.slice(-3).map((s) => (
                <div key={s.id} className="mb-2 rounded border border-ink-700 p-2 font-mono text-[11px]">
                  <div className="flex items-center gap-2">
                    <Badge tone="signal">{s.strategy}@{s.strategyVersion}</Badge>
                    <span>score {s.score}</span>
                    <span className="text-ink-500">conf {s.confidence}</span>
                    <span className="ml-auto text-ink-500">{clock(s.ts)}</span>
                  </div>
                  <div className="mt-1 text-ink-300">{s.rationale}</div>
                  <div className="mt-1 text-ink-500">entry: {s.entryConditions.join(' · ')}</div>
                  <div className="text-ink-500">invalidation: {s.invalidation.join(' · ')}</div>
                  <div className="text-ink-500">max entry price {price(s.maxEntryPrice)} · stop {s.exitPolicy.stopLossPct}% · max hold {Math.round(s.exitPolicy.maxHoldSec / 60)}m</div>
                </div>
              ))}
            </Section>
          )}
          {sizing && (
            <Section title="sizer" right={<Badge tone={sizing.approved ? 'size' : sizing.deferred ? 'warn' : 'risk'}>{sizing.approved ? `size ${usd(sizing.size)}` : sizing.deferred ? 'deferred' : 'rejected'}</Badge>}>
              <KV
                rows={[
                  ['equity', usd(sizing.equity)],
                  ['available', usd(sizing.available)],
                  ['open exposure', usd(sizing.openExposure)],
                  ['max allowed', usd(sizing.maxAllowed)],
                  ['est. entry / exit cost', `${usd(sizing.estEntryCost)} / ${usd(sizing.estExitCost)}`],
                  ['downside at stop', usd(sizing.estDownside)],
                  ['remaining daily risk', usd(sizing.remainingRiskBudget)],
                ]}
              />
              <div className="mt-2 grid grid-cols-2 gap-1 sm:grid-cols-3">
                {sizing.constraints.map((k) => (
                  <div key={k.name} className={cn('rounded border px-2 py-1 font-mono text-[10.5px]', k.binding ? 'border-size/60 bg-size/10 text-size' : 'border-ink-700 text-ink-400')}>
                    {k.name}
                    <div className="text-ink-200">{usd(k.limit)}</div>
                  </div>
                ))}
              </div>
              {sizing.reasons.length > 0 && <div className="mt-2 font-mono text-[11px] text-warn">{sizing.reasons.join(' · ')}</div>}
            </Section>
          )}
          {data && data.orders.length > 0 && (
            <Section title="orders">
              <OrdersTable orders={data.orders} />
            </Section>
          )}
          <Section title="stage history">
            <div className="flex flex-wrap gap-1">
              {c.stageHistory.map((h, i) => (
                <Badge key={i} tone={STAGE_TONE[h.stage] ?? 'neutral'} title={h.reason ?? ''}>
                  {clock(h.ts)} {h.stage.toLowerCase()}
                </Badge>
              ))}
            </div>
          </Section>
          <Section title="audit trail">{data ? <AuditTrail events={data.audit} /> : <Empty>loading…</Empty>}</Section>
        </>
      )}
    </Sheet>
  );
}

function Spark({ values }: { values: number[] }) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${30 - ((v - min) / (max - min || 1)) * 28}`).join(' ');
  const up = values[values.length - 1]! >= values[0]!;
  return (
    <svg viewBox="0 0 100 32" preserveAspectRatio="none" className="mt-2 h-10 w-full">
      <polyline points={pts} fill="none" stroke={up ? 'var(--color-up)' : 'var(--color-down)'} strokeWidth="1" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function OrdersTable({ orders, txs = [] }: { orders: Order[]; txs?: ChainTransaction[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full font-mono text-[11px]">
        <thead className="text-left text-ink-500">
          <tr>
            <th className="py-1 pr-2 font-normal">time</th>
            <th className="pr-2 font-normal">side</th>
            <th className="pr-2 font-normal">in</th>
            <th className="pr-2 font-normal">out</th>
            <th className="pr-2 font-normal">slip</th>
            <th className="pr-2 font-normal">fee</th>
            <th className="pr-2 font-normal">status</th>
            <th className="font-normal">tx</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => {
            const tx = txs.find((t) => t.orderId === o.id);
            return (
              <tr key={o.id} className="border-t border-ink-800 align-top">
                <td className="py-1 pr-2 text-ink-500">{clock(o.createdAt)}</td>
                <td className={cn('pr-2', o.side === 'buy' ? 'text-exec' : 'text-exit')}>{o.side}</td>
                <td className="pr-2">{o.side === 'buy' ? usd(o.filledIn ?? o.amountIn) : compact(o.filledIn ?? o.amountIn)}</td>
                <td className="pr-2">{o.filledOut ? (o.side === 'buy' ? compact(o.filledOut) : usd(o.filledOut)) : '—'}</td>
                <td className="pr-2">{o.slippagePct ? pct(o.slippagePct) : '—'}</td>
                <td className="pr-2">{o.networkFeeQuote ? usd(o.networkFeeQuote) : '—'}</td>
                <td className="pr-2">
                  <Badge tone={o.status === 'confirmed' ? 'equity' : o.status === 'failed' ? 'down' : 'warn'}>{o.status}</Badge>
                  {o.statusReason && <div className="text-[10px] text-ink-500">{o.statusReason}</div>}
                </td>
                <td className="text-ink-500">{tx?.explorerUrl ? <a className="text-exec hover:underline" href={tx.explorerUrl} target="_blank" rel="noreferrer">{short(tx.signature)}</a> : tx ? `${short(tx.signature)}${tx.simulated ? ' (sim)' : ''}` : o.txId ? short(o.txId) : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ───────────────────────── position / trade ─────────────────────────

interface PositionDetail {
  position: Position;
  events: PositionEvent[];
  orders: Order[];
  transactions: ChainTransaction[];
  audit: AuditEvent[];
}

export function PositionSheet() {
  const { inspect, openPosition, state } = useTerminal();
  const id = inspect.positionId;
  const live = state.positions.find((p) => p.id === id);
  const { data, error } = useFetch<PositionDetail>(id ? `/api/positions/${id}` : null, [live?.status, live?.tpLevelsHit]);
  const p = live ?? data?.position;
  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && openPosition(null)} title={p ? `$${p.symbol} · ${p.mode.toUpperCase()} position` : 'Position'} subtitle={p ? `${p.strategy}@${p.strategyVersion} · ${short(p.tokenAddress, 6)}` : undefined} accent="var(--color-exec)" wide>
      {error && <div className="mb-3 font-mono text-[11px] text-down">{error}</div>}
      {p && (
        <>
          <Section title="summary" right={<Badge tone={p.status === 'closed' ? (Number(p.realizedPnl) >= 0 ? 'up' : 'down') : 'exec'}>{p.status}</Badge>}>
            <KV
              rows={[
                ['opened', dateTime(p.openedAt)],
                ['closed', dateTime(p.closedAt)],
                ['entry fill', price(p.entryFillPrice)],
                ['cost basis', usd(p.costBasis)],
                ['proceeds', usd(p.proceeds)],
                ['fees (entry + exit)', `${usd(p.entryFeesQuote)} + ${usd(p.exitFeesQuote)}`],
                ['realized p&l', <span key="r" className={signClass(p.realizedPnl)}>{usd(p.realizedPnl, { sign: true })}</span>],
                ['unrealized', p.lastMark?.unrealizedPnl ? <span key="u" className={signClass(p.lastMark.unrealizedPnl)}>{usd(p.lastMark.unrealizedPnl, { sign: true })}</span> : '—'],
                ['exit reason', p.exitReason ?? '—'],
                ['take-profits hit', `${p.tpLevelsHit}/${p.exitPolicy.takeProfit.length}`],
              ]}
            />
            <div className="mt-2 font-mono text-[11px] text-ink-400">
              <span className="text-scan">entry rationale:</span> {p.entryRationale}
              <br />
              <span className="text-exit">exit rationale:</span> {p.exitRationale ?? '—'}
            </div>
          </Section>
          {data && (
            <>
              <Section title="orders & transactions">
                <OrdersTable orders={data.orders} txs={data.transactions} />
              </Section>
              <Section title="position events">
                <ul className="space-y-1 font-mono text-[11px]">
                  {data.events.map((e) => (
                    <li key={e.id}>
                      <span className="text-ink-500">{clock(e.ts)}</span> <Badge tone={e.type === 'closed' ? 'equity' : e.type.includes('fail') ? 'down' : e.type.includes('exit') ? 'exit' : 'neutral'}>{e.type}</Badge> <span className="text-ink-300">{e.detail}</span>
                    </li>
                  ))}
                </ul>
              </Section>
              <Section title="full audit trail (discovery → reconciliation)">
                <AuditTrail events={data.audit} />
              </Section>
            </>
          )}
        </>
      )}
    </Sheet>
  );
}
