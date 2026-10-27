'use client';

import { LogOut, OctagonX, Pause, Play } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/sheet';
import { Tip } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { age } from '@/lib/format';
import { useNow, useTerminal } from '@/lib/terminal-store';
import { cn } from '@/lib/utils';
import { Logo } from './meta';

const NAV = [
  { href: '/', label: 'Terminal' },
  { href: '/trades', label: 'Trades' },
  { href: '/backtest', label: 'Backtest' },
  { href: '/settings', label: 'Settings' },
];

export function TopBar() {
  const { state, stream, isAdmin } = useTerminal();
  const path = usePathname();
  const now = useNow();
  const st = state.status;
  const [killOpen, setKillOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState('');

  const online = state.agents.filter((a) => a.state !== 'error' && a.state !== 'disabled').length;
  const dataAge = st?.lastMarketDataAt ? now - st.lastMarketDataAt : null;
  const streamOk = stream === 'live';
  // Never show a healthy indicator when the stream or providers are down.
  const health = !streamOk || !st?.running ? 'down' : st.health;
  const live = st?.mode === 'live';

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <header className={cn('sticky top-0 z-30 border-b bg-ink-950/90 backdrop-blur', live ? 'border-live/50' : 'border-ink-700')}>
      {live && <div className="h-[3px] w-full bg-[repeating-linear-gradient(45deg,var(--color-live)_0_8px,transparent_8px_16px)]" />}
      <div className="flex h-12 items-center gap-2 px-3 sm:gap-3 lg:px-4">
        <Link href="/" className="flex shrink-0 items-center gap-2.5">
          <Logo />
          <div className="hidden leading-tight sm:block">
            <div className="text-[13px] font-semibold tracking-tight text-ink-100">{st?.name ?? 'Sniper Terminal'}</div>
            <div className="num text-[10px] text-ink-500">v{st?.version ?? '—'} · {st?.chain ?? '—'}</div>
          </div>
        </Link>

        <nav className="ml-2 hidden items-center gap-0.5 md:flex">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className={cn('rounded-[4px] px-2.5 py-1.5 font-mono text-[11px] uppercase tracking-[0.1em] transition-colors', path === n.href ? 'bg-ink-800 text-ink-100' : 'text-ink-400 hover:text-ink-200')}>
              {n.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex min-w-0 items-center gap-2">
          <Tip content={live ? 'Live trading is authorized. Orders reach the blockchain.' : 'Paper mode: every order is simulated against a separate ledger.'}>
            <span>{live ? <Badge tone="live" className="h-6 px-2 text-[11px]">● live trading</Badge> : <Badge tone="exec" className="h-6 px-2 text-[11px]">paper</Badge>}</span>
          </Tip>
          {st?.simulatedMarket && (
            <Tip content="Market data comes from the built-in deterministic simulator. No real tokens, prices or trades.">
              <span>
                <Badge tone="warn" className="h-6 px-2">
                  sim<span className="hidden sm:inline">ulated data</span>
                </Badge>
              </span>
            </Tip>
          )}
          <div className="hidden items-center gap-3 border-l border-ink-700 pl-3 lg:flex">
            <Indicator label="health" value={health} tone={health === 'ok' ? 'up' : health === 'degraded' ? 'warn' : 'down'} />
            <Indicator label="stream" value={stream} tone={streamOk ? 'up' : stream === 'connecting' || stream === 'reconnecting' ? 'warn' : 'down'} />
            <Indicator label="agents" value={`${online}/${state.agents.length || 9}`} tone={online === state.agents.length ? 'up' : 'warn'} />
            <Indicator label="uptime" value={st ? age(now - st.startedAt) : '—'} />
            <Indicator label="data" value={dataAge === null ? 'none' : `${age(dataAge)} ago`} tone={dataAge !== null && dataAge < 10_000 && streamOk ? 'up' : 'warn'} />
          </div>
          {isAdmin && st && (
            <div className="flex items-center gap-1.5 border-l border-ink-700 pl-3">
              <Button size="sm" variant={st.entriesPaused ? 'success' : 'default'} disabled={busy || st.killSwitch} onClick={() => act(() => api('/api/control/pause', { method: 'POST', body: { paused: !st.entriesPaused } }))} title={st.entriesPaused ? 'Resume new entries' : 'Pause new entries (exits continue)'}>
                {st.entriesPaused ? <Play size={12} /> : <Pause size={12} />}
                <span className="hidden xl:inline">{st.entriesPaused ? 'resume' : 'pause'}</span>
              </Button>
              <Button size="sm" variant="danger" className={cn(st.killSwitch && 'bg-risk/30')} disabled={busy} onClick={() => setKillOpen(true)}>
                <OctagonX size={12} />
                <span className="hidden xl:inline">{st.killSwitch ? 'kill: on' : 'kill switch'}</span>
              </Button>
            </div>
          )}
          <Button size="icon" variant="ghost" title="Sign out" onClick={() => act(async () => { await api('/api/auth/logout', { method: 'POST' }); window.location.href = '/login'; })}>
            <LogOut size={14} />
          </Button>
        </div>
      </div>
      <nav className="flex gap-0.5 overflow-x-auto border-t border-ink-800 px-2 py-1 md:hidden">
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} className={cn('shrink-0 rounded-[4px] px-2.5 py-1 font-mono text-[10.5px] uppercase tracking-[0.1em]', path === n.href ? 'bg-ink-800 text-ink-100' : 'text-ink-400')}>
            {n.label}
          </Link>
        ))}
      </nav>
      {(err || (st && (st.killSwitch || st.entriesPaused || st.breakers.some((b) => b.tripped)))) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-ink-800 bg-ink-900/80 px-4 py-1.5 font-mono text-[11px]">
          {st?.killSwitch && <span className="text-risk">■ KILL SWITCH ACTIVE — new orders blocked · positions: {st.killSwitchPolicy.replace('_', ' ')}</span>}
          {st?.entriesPaused && !st.killSwitch && <span className="text-warn">■ entries paused{st.pauseReason ? ` (${st.pauseReason})` : ''} — exits still managed</span>}
          {st?.breakers.filter((b) => b.tripped).map((b) => (
            <span key={b.id} className="text-warn">
              ▲ breaker: {b.label} — {b.reason}
            </span>
          ))}
          {err && <span className="text-down">error: {err}</span>}
        </div>
      )}
      <Modal open={killOpen} onOpenChange={(o) => { setKillOpen(o); setConfirm(''); }} title={st?.killSwitch ? 'Release kill switch' : 'Activate kill switch'}>
        {st?.killSwitch ? (
          <div className="space-y-3 text-xs text-ink-300">
            <p>New entries become possible again once released (subject to pause state and breakers). Type <span className="num text-ink-100">RELEASE</span> to confirm.</p>
            <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="RELEASE" autoFocus />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setKillOpen(false)}>cancel</Button>
              <Button variant="primary" disabled={confirm !== 'RELEASE' || busy} onClick={() => act(async () => { await api('/api/control/kill-switch', { method: 'POST', body: { on: false, confirm } }); setKillOpen(false); })}>release</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3 text-xs text-ink-300">
            <p>Immediately blocks every new order and cancels pending proposals.</p>
            <p>
              Open positions follow the configured policy: <span className="num text-ink-100">{st?.killSwitchPolicy}</span>
              {st?.killSwitchPolicy === 'close_all' ? ' — every open position will be sold now.' : st?.killSwitchPolicy === 'exits_only' ? ' — stops and targets keep running.' : ' — no orders at all; positions are only monitored.'}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setKillOpen(false)}>cancel</Button>
              <Button variant="danger" disabled={busy} onClick={() => act(async () => { await api('/api/control/kill-switch', { method: 'POST', body: { on: true } }); setKillOpen(false); })}>activate</Button>
            </div>
          </div>
        )}
      </Modal>
    </header>
  );
}

function Indicator({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'warn' | 'down' }) {
  return (
    <div className="flex items-center gap-1.5">
      {tone && <span className={cn('h-1.5 w-1.5 rounded-full', tone === 'up' ? 'dot-live bg-up' : tone === 'warn' ? 'bg-warn' : 'bg-down')} />}
      <span className="label !tracking-[0.1em]">{label}</span>
      <span className="num text-[11px] text-ink-200">{value}</span>
    </div>
  );
}
