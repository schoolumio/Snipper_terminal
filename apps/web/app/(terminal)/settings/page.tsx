'use client';

import { checkHardLimits, EngineConfigSchema, STRATEGY_IDS, type EngineConfig, type HardLimits } from '@sniper/core/config';
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { Panel } from '@/components/ui/panel';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { dateTime, usd } from '@/lib/format';
import { useTerminal } from '@/lib/terminal-store';
import { cn } from '@/lib/utils';

type Path = (string | number)[];

function getAt(o: unknown, p: Path): unknown {
  return p.reduce<unknown>((x, k) => (x as Record<string | number, unknown>)?.[k], o);
}
function setAt<T>(o: T, p: Path, v: unknown): T {
  const c = structuredClone(o) as Record<string | number, unknown>;
  let cur = c;
  for (let i = 0; i < p.length - 1; i++) cur = cur[p[i]!] as Record<string | number, unknown>;
  cur[p[p.length - 1]!] = v;
  return c as T;
}

interface Ctx {
  cfg: EngineConfig;
  set: (p: Path, v: unknown) => void;
  errors: Record<string, string>;
  readOnly: boolean;
}

function Field({ ctx, path, label, hint, kind = 'dec', unit, hard }: { ctx: Ctx; path: Path; label: string; hint?: string; kind?: 'dec' | 'int' | 'float'; unit?: string; hard?: string }) {
  const v = getAt(ctx.cfg, path);
  const key = path.join('.');
  const err = ctx.errors[key];
  // Local draft so partial input like "0." survives until it parses.
  const [draft, setDraft] = useState(String(v ?? ''));
  useEffect(() => {
    setDraft((d) => (kind === 'dec' ? String(v ?? '') : Number(d) === v ? d : String(v ?? '')));
  }, [v, kind]);
  return (
    <label className="block">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] text-ink-200">{label}</span>
        {hard && <span className="num text-[9.5px] text-ink-500">hard max {hard}</span>}
      </div>
      <div className="relative mt-1">
        <Input
          value={draft}
          disabled={ctx.readOnly}
          onChange={(e) => {
            const raw = e.target.value.trim();
            setDraft(raw);
            if (kind === 'dec') ctx.set(path, raw);
            else if (/^-?\d*\.?\d+$/.test(raw)) ctx.set(path, Number(raw));
            else ctx.set(path, raw === '' ? Number.NaN : raw);
          }}
          className={cn(unit && 'pr-10', err && 'border-down/70')}
          inputMode="decimal"
        />
        {unit && <span className="num pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-ink-500">{unit}</span>}
      </div>
      {err ? <div className="mt-0.5 font-mono text-[10px] text-down">{err}</div> : hint && <div className="mt-0.5 text-[10.5px] text-ink-500">{hint}</div>}
    </label>
  );
}

function Toggle({ ctx, path, label, hint }: { ctx: Ctx; path: Path; label: string; hint?: string }) {
  const v = Boolean(getAt(ctx.cfg, path));
  return (
    <div className="flex items-start justify-between gap-3 py-1">
      <div>
        <div className="text-[12px] text-ink-200">{label}</div>
        {hint && <div className="text-[10.5px] text-ink-500">{hint}</div>}
      </div>
      <Switch checked={v} disabled={ctx.readOnly} onCheckedChange={(x) => ctx.set(path, x)} />
    </div>
  );
}

function Group({ index, title, accent, children, desc }: { index: string; title: string; accent: string; children: ReactNode; desc?: string }) {
  return (
    <Panel index={index} title={title} accent={accent} bodyClassName="p-3">
      {desc && <p className="mb-3 text-[11px] text-ink-400">{desc}</p>}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{children}</div>
    </Panel>
  );
}

export default function SettingsPage() {
  const { isAdmin, state } = useTerminal();
  const [server, setServer] = useState<{ version: number; config: EngineConfig; hardLimits: HardLimits } | null>(null);
  const [cfg, setCfg] = useState<EngineConfig | null>(null);
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [versions, setVersions] = useState<{ version: number; changedBy: string; changedAt: number; note: string }[]>([]);

  const load = async () => {
    const s = await api<{ version: number; config: EngineConfig; hardLimits: HardLimits }>('/api/config');
    setServer(s);
    setCfg(s.config);
    setVersions(await api('/api/config/versions?limit=15'));
  };
  useEffect(() => {
    void load();
  }, []);

  const errors = useMemo(() => {
    if (!cfg || !server) return {};
    const out: Record<string, string> = {};
    const r = EngineConfigSchema.safeParse(cfg);
    if (!r.success) for (const i of r.error.issues) out[i.path.join('.')] = i.message;
    for (const v of checkHardLimits(cfg, server.hardLimits)) out[v.path] = v.message;
    return out;
  }, [cfg, server]);

  if (!cfg || !server) return <div className="p-6 font-mono text-xs text-ink-400">loading configuration…</div>;
  const ctx: Ctx = { cfg, set: (p, v) => setCfg((c) => (c ? setAt(c, p, v) : c)), errors, readOnly: !isAdmin };
  const dirty = JSON.stringify(cfg) !== JSON.stringify(server.config);
  const hl = server.hardLimits;
  const nErr = Object.keys(errors).length;

  const save = async () => {
    setMsg(null);
    try {
      const r = await api<{ version: number }>('/api/config', { method: 'PUT', body: { config: cfg, note } });
      setMsg({ ok: true, text: `saved as config v${r.version} — takes effect on the next engine tick; open positions keep their exit policy version` });
      setNote('');
      await load();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    }
  };

  const t = ['trading'];
  const r = ['risk'];
  const th = ['risk', 'thresholds'];
  const ex = ['trading', 'exitPolicy'];
  const sp = ['trading', 'strategyParams'];

  return (
    <div className="space-y-2.5 pb-24">
      <div className="panel flex flex-wrap items-center gap-3 px-4 py-3">
        <div>
          <div className="text-[15px] font-semibold">Strategy & risk configuration</div>
          <div className="font-mono text-[11px] text-ink-400">
            active v{server.version} · validated on the server · hard limits come from the server environment and cannot be raised here
          </div>
        </div>
        {!isAdmin && <Badge tone="warn">read-only (viewer)</Badge>}
        <div className="ml-auto flex items-center gap-2">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="change note (audited)" className="w-56" disabled={!isAdmin} />
          <Button variant="ghost" disabled={!dirty} onClick={() => setCfg(server.config)}>
            discard
          </Button>
          <Button variant="primary" disabled={!isAdmin || !dirty || nErr > 0} onClick={save}>
            save v{server.version + 1}
          </Button>
        </div>
        {(msg || nErr > 0) && <div className={cn('w-full font-mono text-[11px]', msg?.ok ? 'text-up' : 'text-down')}>{msg?.text ?? `${nErr} validation issue(s) — fix before saving`}</div>}
      </div>

      <div className="grid grid-cols-1 gap-2.5 xl:grid-cols-2">
        <Group index="S1" title="Trading" accent="var(--color-exec)" desc={`Chain: ${cfg.trading.chain} (served by the configured market provider). Allocation is an upper bound — the sizer also caps by liquidity, exposure and risk budget.`}>
          <Field ctx={ctx} path={[...t, 'maxConcurrentPositions']} label="Max concurrent positions" kind="int" hard={String(hl.maxConcurrentPositions)} />
          <Field ctx={ctx} path={[...t, 'maxTradeAllocationPct']} label="Max trade allocation" unit="% eq" hard={`${hl.maxTradeAllocationPct}%`} />
          <Field ctx={ctx} path={[...t, 'minLiquidity']} label="Min liquidity" unit="USD" />
          <Field ctx={ctx} path={[...t, 'maxLiquidity']} label="Max liquidity" unit="USD" />
          <Field ctx={ctx} path={[...t, 'minPoolAgeSec']} label="Min pool age" unit="sec" kind="int" />
          <Field ctx={ctx} path={[...t, 'maxPoolAgeSec']} label="Max pool age" unit="sec" kind="int" />
          <Field ctx={ctx} path={[...t, 'maxPriceImpactPct']} label="Max price impact" unit="%" hard={`${hl.maxPriceImpactPct}%`} />
          <Field ctx={ctx} path={[...t, 'maxSlippagePct']} label="Max slippage (entries)" unit="%" hard={`${hl.maxSlippagePct}%`} hint="exits tolerate 2× (4× emergency), capped at 25%" />
          <Field ctx={ctx} path={[...t, 'maxNetworkFeeQuote']} label="Max network fee" unit="USD" />
          <Field ctx={ctx} path={[...t, 'priorityFeeQuote']} label="Priority fee" unit="USD" />
          <Field ctx={ctx} path={[...t, 'minScannerScore']} label="Min scanner score" kind="float" />
          <Field ctx={ctx} path={[...t, 'minSignalScore']} label="Min signal score" kind="float" />
          <Field ctx={ctx} path={[...t, 'minSignalConfidence']} label="Min signal confidence" kind="float" hint="0 – 1" />
          <Field ctx={ctx} path={[...t, 'entryCooldownSec']} label="Entry cooldown" unit="sec" kind="int" />
          <Field ctx={ctx} path={[...t, 'proposalTtlSec']} label="Proposal TTL" unit="sec" kind="int" />
          <Field ctx={ctx} path={[...t, 'candidateTtlSec']} label="Candidate TTL" unit="sec" kind="int" />
          <Field ctx={ctx} path={[...t, 'reevaluateEverySec']} label="Re-evaluate every" unit="sec" kind="int" />
        </Group>

        <Group index="S2" title="Portfolio protection" accent="var(--color-size)" desc="Hard-stops for the whole book. Breaching daily loss or drawdown trips a circuit breaker that blocks new entries.">
          <Field ctx={ctx} path={[...r, 'maxDailyLossPct']} label="Max daily loss" unit="%" hard={`${hl.maxDailyLossPct}%`} />
          <Field ctx={ctx} path={[...r, 'maxDrawdownPct']} label="Max drawdown" unit="%" hard={`${hl.maxDrawdownPct}%`} />
          <Field ctx={ctx} path={[...r, 'maxTokenExposurePct']} label="Max exposure per token" unit="% eq" />
          <Field ctx={ctx} path={[...r, 'maxTotalExposurePct']} label="Max total exposure" unit="% eq" hard={`${hl.maxTotalExposurePct}%`} />
          <Field ctx={ctx} path={[...r, 'maxNewLaunchExposurePct']} label="Max new-launch exposure" unit="% eq" />
          <Field ctx={ctx} path={[...r, 'maxPositionSizeQuote']} label="Max position size" unit="USD" hard={usd(hl.maxPositionSizeQuote)} />
          <Field ctx={ctx} path={[...r, 'minTradeSizeQuote']} label="Min trade size" unit="USD" />
          <Field ctx={ctx} path={[...r, 'minFeeReserveQuote']} label="Fee reserve" unit="USD" />
          <Field ctx={ctx} path={[...r, 'riskPerTradePct']} label="Risk per trade" unit="% eq" hint="loss budget at the stop, incl. costs" />
          <Field ctx={ctx} path={[...r, 'maxLiquidityParticipationPct']} label="Max pool participation" unit="% liq" />
          <Field ctx={ctx} path={[...r, 'consecutiveLossLimit']} label="Consecutive-loss breaker" kind="int" />
          <Field ctx={ctx} path={[...r, 'consecutiveLossCooldownSec']} label="Loss cooldown" unit="sec" kind="int" />
          <Field ctx={ctx} path={[...r, 'maxExecutionErrors']} label="Execution-error breaker" kind="int" />
          <Field ctx={ctx} path={[...r, 'executionErrorWindowSec']} label="Error window" unit="sec" kind="int" />
        </Group>

        <Group index="S3" title="Token security thresholds" accent="var(--color-risk)" desc="Unknown critical data is never treated as safe. A liquidity-lock claim without verification counts as unlocked.">
          <Field ctx={ctx} path={[...r, 'maxRiskScore']} label="Reject above risk score" kind="float" />
          <Field ctx={ctx} path={[...r, 'reviewRiskScore']} label="Review above risk score" kind="float" />
          <Field ctx={ctx} path={[...r, 'minRiskConfidence']} label="Min data confidence" kind="float" hint="0 – 1, below → REVIEW" />
          <Field ctx={ctx} path={[...th, 'maxTop10HolderPct']} label="Max top-10 holders" unit="%" />
          <Field ctx={ctx} path={[...th, 'maxCreatorHoldingPct']} label="Max creator holding" unit="%" />
          <Field ctx={ctx} path={[...th, 'maxTransferTaxPct']} label="Max transfer tax" unit="%" />
          <Field ctx={ctx} path={[...th, 'minLiquidityToMcapPct']} label="Min liquidity / mcap" unit="%" />
          <Field ctx={ctx} path={[...th, 'maxVolumeToLiquidity1h']} label="Max 1h volume / liquidity" unit="×" />
          <Field ctx={ctx} path={[...th, 'maxDataAgeSec']} label="Max data age" unit="sec" kind="int" />
          <Field ctx={ctx} path={[...th, 'minHolders']} label="Min holders" kind="int" />
          <div className="sm:col-span-2">
            <Toggle ctx={ctx} path={[...th, 'requireSellSimulation']} label="Require a successful sell simulation" hint="blocks honeypots; unknown → reject" />
            <Toggle ctx={ctx} path={[...th, 'requireMintRenounced']} label="Require mint authority renounced" />
            <Toggle ctx={ctx} path={[...th, 'requireFreezeRenounced']} label="Require freeze authority renounced" />
            <Toggle ctx={ctx} path={[...th, 'requireVerifiedLpLock']} label="Require independently verified LP lock" />
          </div>
        </Group>

        <Group index="S4" title="Exit policy" accent="var(--color-exit)" desc={`Version ${cfg.trading.exitPolicy.version}. Changes create a new version for new positions; open positions keep theirs. Stops are enforced by this application against executable quotes — not on-chain — so they only act while the engine runs and a sell can land.`}>
          <Field ctx={ctx} path={[...ex, 'stopLossPct']} label="Stop loss" unit="%" />
          <Field ctx={ctx} path={[...ex, 'maxHoldSec']} label="Max holding time" unit="sec" kind="int" />
          <Field ctx={ctx} path={[...ex, 'liquidityDropPct']} label="Exit on liquidity drop" unit="%" />
          <div />
          <div className="sm:col-span-2">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[12px] text-ink-200">Take-profit ladder</span>
              <Button size="sm" variant="ghost" disabled={!isAdmin || cfg.trading.exitPolicy.takeProfit.length >= 6} onClick={() => ctx.set([...ex, 'takeProfit'], [...cfg.trading.exitPolicy.takeProfit, { gainPct: '100', sellFraction: '1' }])}>
                <Plus size={11} /> level
              </Button>
            </div>
            {cfg.trading.exitPolicy.takeProfit.map((_, i) => (
              <div key={i} className="mb-2 grid grid-cols-[1fr_1fr_auto] items-end gap-2">
                <Field ctx={ctx} path={[...ex, 'takeProfit', i, 'gainPct']} label={`TP${i + 1} gain`} unit="%" />
                <Field ctx={ctx} path={[...ex, 'takeProfit', i, 'sellFraction']} label="sell fraction of remaining" hint="0.01 – 1" />
                <Button size="icon" variant="ghost" disabled={!isAdmin} onClick={() => ctx.set([...ex, 'takeProfit'], cfg.trading.exitPolicy.takeProfit.filter((__, j) => j !== i))}>
                  <Trash2 size={12} />
                </Button>
              </div>
            ))}
          </div>
          <div className="sm:col-span-2 grid gap-3 sm:grid-cols-2">
            <div className="space-y-2 rounded border border-ink-700 p-2">
              <Toggle ctx={ctx} path={[...ex, 'trailing', 'enabled']} label="Trailing stop" />
              <Field ctx={ctx} path={[...ex, 'trailing', 'activateAtGainPct']} label="Activate at gain" unit="%" />
              <Field ctx={ctx} path={[...ex, 'trailing', 'trailPct']} label="Trail distance" unit="%" />
            </div>
            <div className="space-y-2 rounded border border-ink-700 p-2">
              <Toggle ctx={ctx} path={[...ex, 'breakEven', 'enabled']} label="Break-even stop" />
              <Field ctx={ctx} path={[...ex, 'breakEven', 'triggerGainPct']} label="Arm at gain" unit="%" />
              <Toggle ctx={ctx} path={[...ex, 'momentumReversal', 'enabled']} label="Momentum-reversal exit" />
              <Field ctx={ctx} path={[...ex, 'momentumReversal', 'm5DropPct']} label="5m drop" unit="%" />
              <Field ctx={ctx} path={[...ex, 'momentumReversal', 'sellBuyRatio']} label="Sell/buy ratio" unit="×" />
            </div>
          </div>
        </Group>

        <Panel index="S5" title="Strategies" accent="var(--color-signal)" bodyClassName="p-3 space-y-3" className="xl:col-span-2">
          <div className="grid gap-3 lg:grid-cols-5">
            {STRATEGY_IDS.map((id) => {
              const on = cfg.trading.enabledStrategies.includes(id);
              const params = cfg.trading.strategyParams[id] as Record<string, unknown>;
              return (
                <div key={id} className={cn('rounded border p-2.5', on ? 'border-signal/40' : 'border-ink-700 opacity-70')}>
                  <div className="mb-2 flex items-center justify-between">
                    <span className="font-mono text-[11.5px] text-ink-100">{id}</span>
                    <Switch checked={on} disabled={!isAdmin} onCheckedChange={(x) => ctx.set([...t, 'enabledStrategies'], x ? [...cfg.trading.enabledStrategies, id] : cfg.trading.enabledStrategies.filter((s) => s !== id))} />
                  </div>
                  <div className="space-y-2">
                    {Object.keys(params).map((k) => (
                      <Field key={k} ctx={ctx} path={[...sp, id, k]} label={k} kind={typeof params[k] === 'number' ? 'int' : 'dec'} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>

        <Panel index="S6" title="Policies" accent="var(--color-orch)" bodyClassName="p-3 space-y-3">
          <label className="block">
            <span className="text-[12px] text-ink-200">Kill-switch position policy</span>
            <Select className="mt-1 w-full" disabled={!isAdmin} value={cfg.risk.killSwitchPolicy} onChange={(e) => ctx.set([...r, 'killSwitchPolicy'], e.target.value)}>
              <option value="exits_only">exits_only — block entries, keep stops & targets running</option>
              <option value="close_all">close_all — sell every open position immediately</option>
              <option value="block_all">block_all — no orders at all, monitor only</option>
            </Select>
          </label>
          <label className="block">
            <span className="text-[12px] text-ink-200">REVIEW verdict policy</span>
            <Select className="mt-1 w-full" disabled={!isAdmin} value={cfg.risk.reviewPolicy} onChange={(e) => ctx.set([...r, 'reviewPolicy'], e.target.value)}>
              <option value="strict">strict — smaller size + higher signal bar</option>
              <option value="manual">manual — require operator approval</option>
              <option value="reject">reject — treat REVIEW as REJECT</option>
            </Select>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <Field ctx={ctx} path={[...r, 'reviewSizeMultiplier']} label="Review size multiplier" hint="0 – 1" />
            <Field ctx={ctx} path={[...r, 'reviewMinSignalScore']} label="Review min signal" kind="float" />
          </div>
          <Toggle ctx={ctx} path={[...r, 'requireManualApprovalLive']} label="Require manual approval for every live trade" />
        </Panel>

        <LivePanel />
        <PaperPanel />

        <Panel index="S9" title="Configuration history" bodyClassName="max-h-72 overflow-y-auto">
          {versions.map((v) => (
            <div key={v.version} className="flex items-center gap-3 border-b border-ink-800 px-3 py-1.5 font-mono text-[11px]">
              <Badge tone={v.version === server.version ? 'exec' : 'neutral'}>v{v.version}</Badge>
              <span className="text-ink-400">{dateTime(v.changedAt)}</span>
              <span className="text-ink-200">{v.changedBy}</span>
              <span className="truncate text-ink-500">{v.note}</span>
            </div>
          ))}
        </Panel>
      </div>
      {state.status && !state.status.persistent && <div className="font-mono text-[11px] text-warn">Server is running without DATABASE_URL — configuration changes are not persisted across restarts.</div>}
    </div>
  );
}

function LivePanel() {
  const { isAdmin, state } = useTerminal();
  const [info, setInfo] = useState<{ enabledByServer: boolean; adapterConfigured: boolean; authorized: boolean; mode: string; chain: string; wallet: string | null; requiredConfirmation: string } | null>(null);
  const [confirm, setConfirm] = useState('');
  const [wallet, setWallet] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    void api<typeof info>('/api/live').then(setInfo);
  }, [state.status?.mode]);
  const authorize = async () => {
    setMsg(null);
    try {
      await api('/api/live/authorize', { method: 'POST', body: { confirm, walletLabel: wallet } });
      setMsg('live trading authorized');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };
  const revoke = async () => {
    try {
      await api('/api/live/revoke', { method: 'POST' });
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Panel index="S7" title="Live trading" accent="var(--color-live)" bodyClassName="p-3 space-y-3">
      {info && (
        <div className="grid grid-cols-2 gap-2 font-mono text-[11px]">
          <Check ok={info.enabledByServer} label="LIVE_TRADING_ENABLED on server" />
          <Check ok={info.adapterConfigured} label="live execution adapter configured" />
          <Check ok={info.authorized} label="authorized in this session" />
          <div className="text-ink-400">
            chain <span className="text-ink-200">{info.chain}</span> · wallet <span className="text-ink-200">{info.wallet ?? 'none'}</span>
          </div>
        </div>
      )}
      <p className="text-[11px] leading-relaxed text-ink-400">
        Live mode is off after every deploy, restart or reconnect. It uses a separate ledger, hard server-side limits and the same pre-trade checks; signing keys never reach the browser. This build ships no live execution adapter — see <span className="font-mono text-ink-300">docs/providers.md</span>.
      </p>
      {info?.authorized ? (
        <Button variant="danger" disabled={!isAdmin} onClick={revoke}>
          revoke live · return to paper
        </Button>
      ) : (
        <div className="space-y-2">
          <Input placeholder={`type: ${info?.requiredConfirmation ?? 'ENABLE LIVE TRADING'}`} value={confirm} onChange={(e) => setConfirm(e.target.value)} disabled={!isAdmin || !info?.adapterConfigured} />
          <Input placeholder="re-type the wallet shown above" value={wallet} onChange={(e) => setWallet(e.target.value)} disabled={!isAdmin || !info?.adapterConfigured} />
          <Button variant="danger" disabled={!isAdmin || !info?.enabledByServer || !info.adapterConfigured || confirm !== info.requiredConfirmation || !wallet} onClick={authorize}>
            authorize live trading
          </Button>
        </div>
      )}
      {msg && <div className="font-mono text-[11px] text-warn">{msg}</div>}
    </Panel>
  );
}

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className={ok ? 'text-up' : 'text-ink-500'}>
      {ok ? '✓' : '✗'} {label}
    </div>
  );
}

function PaperPanel() {
  const { isAdmin, state } = useTerminal();
  const [amount, setAmount] = useState('100');
  const [msg, setMsg] = useState<string | null>(null);
  const p = state.performance?.paper;
  const go = async (kind: 'deposit' | 'withdraw') => {
    setMsg(null);
    try {
      await api(`/api/paper/${kind}`, { method: 'POST', body: { amount } });
      setMsg(`${kind} of ${usd(amount)} recorded (not counted as P&L)`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Panel index="S8" title="Paper ledger" accent="var(--color-equity)" bodyClassName="p-3 space-y-3">
      <div className="font-mono text-[11px] text-ink-400">
        equity <span className="text-ink-100">{usd(p?.equity)}</span> · available <span className="text-ink-100">{usd(p?.available)}</span> · start {usd(p?.startingEquity)}
      </div>
      <div className="flex gap-2">
        <Input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} className="w-32" />
        <Button disabled={!isAdmin} onClick={() => go('deposit')}>
          deposit
        </Button>
        <Button disabled={!isAdmin} onClick={() => go('withdraw')}>
          withdraw
        </Button>
      </div>
      <p className="text-[11px] text-ink-500">Deposits and withdrawals adjust cash, peak and day-start equity; they are never reported as trading profit or loss.</p>
      {msg && <div className="font-mono text-[11px] text-ink-300">{msg}</div>}
    </Panel>
  );
}
