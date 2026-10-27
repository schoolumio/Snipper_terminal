'use client';

import type {
  AgentStatus,
  Alert,
  AuditEvent,
  Candidate,
  DashboardSnapshot,
  EngineEvent,
  EngineStatus,
  EquitySnapshot,
  PerformanceStats,
  PipelineCounters,
  Position,
  TradeProposal,
  TradingMode,
} from '@sniper/core/types';
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { api, wsUrl } from './api';

export type StreamState = 'connecting' | 'live' | 'reconnecting' | 'offline';

export interface TerminalState {
  loaded: boolean;
  status: EngineStatus | null;
  agents: AgentStatus[];
  candidates: Candidate[];
  positions: Position[];
  performance: { paper: PerformanceStats; live: PerformanceStats } | null;
  equity: { paper: EquitySnapshot[]; live: EquitySnapshot[] };
  audit: AuditEvent[];
  alerts: Alert[];
  counters: PipelineCounters | null;
  approvals: TradeProposal[];
  user: { username: string; role: 'admin' | 'viewer' } | null;
  lastEventAt: number | null;
}

const initial: TerminalState = {
  loaded: false,
  status: null,
  agents: [],
  candidates: [],
  positions: [],
  performance: null,
  equity: { paper: [], live: [] },
  audit: [],
  alerts: [],
  counters: null,
  approvals: [],
  user: null,
  lastEventAt: null,
};

type Action = { type: 'snapshot'; data: DashboardSnapshot; user?: TerminalState['user'] } | { type: 'events'; events: EngineEvent[] } | { type: 'user'; user: TerminalState['user'] };

const AUDIT_CAP = 600;
const CANDIDATE_CAP = 300;
const TERMINAL = new Set(['REJECTED', 'CLOSED', 'EXPIRED', 'FAILED', 'CANCELLED']);

function upsert<T extends { id: string }>(xs: T[], x: T): T[] {
  const i = xs.findIndex((y) => y.id === x.id);
  if (i === -1) return [x, ...xs];
  const next = xs.slice();
  next[i] = x;
  return next;
}

function reducer(state: TerminalState, action: Action): TerminalState {
  switch (action.type) {
    case 'user':
      return { ...state, user: action.user };
    case 'snapshot': {
      const d = action.data;
      return {
        ...state,
        loaded: true,
        status: d.status,
        agents: d.agents,
        candidates: d.candidates,
        positions: d.positions,
        performance: d.performance,
        equity: d.equity,
        audit: d.audit,
        alerts: d.alerts,
        counters: d.counters,
        approvals: d.pendingApprovals,
        user: action.user ?? state.user,
        lastEventAt: Date.now(),
      };
    }
    case 'events': {
      let s = { ...state, lastEventAt: Date.now() };
      let audit: AuditEvent[] | null = null;
      for (const e of action.events) {
        switch (e.type) {
          case 'audit': {
            // Events queued before the hello snapshot may arrive again: seq is monotonic.
            const buf = (audit ??= s.audit.slice());
            const last = buf[buf.length - 1]?.seq ?? 0;
            if (e.data.seq > last) buf.push(e.data);
            break;
          }
          case 'agent':
            s.agents = s.agents.map((a) => (a.id === e.data.id ? e.data : a));
            break;
          case 'candidate': {
            let cs = upsert(s.candidates, e.data);
            if (cs.length > CANDIDATE_CAP) {
              const drop = cs.filter((c) => TERMINAL.has(c.stage)).sort((a, b) => a.updatedAt - b.updatedAt)[0];
              if (drop) cs = cs.filter((c) => c.id !== drop.id);
            }
            s.candidates = cs;
            if (e.data.stage !== 'TRADE_PROPOSED') s.approvals = s.approvals.filter((p) => p.candidateId !== e.data.id);
            break;
          }
          case 'position':
            s.positions = upsert(s.positions, e.data);
            break;
          case 'equity': {
            const m = e.data.mode;
            const series = [...s.equity[m], e.data];
            s.equity = { ...s.equity, [m]: series.length > 2000 ? series.slice(-2000) : series };
            break;
          }
          case 'alert':
            s.alerts = [e.data, ...s.alerts.filter((a) => a.id !== e.data.id)].slice(0, 100);
            break;
          case 'status':
            s.status = e.data;
            break;
          case 'counters':
            s.counters = e.data;
            break;
          case 'performance':
            s.performance = e.data;
            break;
          case 'approval':
            s.approvals = upsert(s.approvals, e.data);
            break;
          case 'order':
            break;
        }
      }
      if (audit) s = { ...s, audit: audit.length > AUDIT_CAP ? audit.slice(-AUDIT_CAP) : audit };
      return s;
    }
  }
}

interface Ctx {
  state: TerminalState;
  stream: StreamState;
  viewMode: TradingMode;
  setViewMode: (m: TradingMode) => void;
  refresh: () => Promise<void>;
  isAdmin: boolean;
  /** Entities opened in side sheets. */
  inspect: { candidateId: string | null; agentId: string | null; positionId: string | null };
  openCandidate: (id: string | null) => void;
  openAgent: (id: string | null) => void;
  openPosition: (id: string | null) => void;
}

const TerminalContext = createContext<Ctx | null>(null);

export function TerminalProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial);
  const [stream, setStream] = useState<StreamState>('connecting');
  const [viewMode, setViewMode] = useState<TradingMode>('paper');
  const [inspect, setInspect] = useState<Ctx['inspect']>({ candidateId: null, agentId: null, positionId: null });
  const wsRef = useRef<WebSocket | null>(null);
  const retry = useRef(0);
  const stopped = useRef(false);

  const refresh = useCallback(async () => {
    const [snap, me] = await Promise.all([api<DashboardSnapshot>('/api/dashboard'), api<{ username: string; role: 'admin' | 'viewer' }>('/api/auth/me')]);
    dispatch({ type: 'snapshot', data: snap, user: me });
  }, []);

  useEffect(() => {
    stopped.current = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const connect = async () => {
      if (stopped.current) return;
      try {
        if (!state.loaded) await refresh();
        const { ticket } = await api<{ ticket: string }>('/api/auth/ws-ticket', { method: 'POST' });
        const ws = new WebSocket(`${wsUrl()}?ticket=${encodeURIComponent(ticket)}`);
        wsRef.current = ws;
        ws.onopen = () => {
          retry.current = 0;
          setStream('live');
        };
        ws.onmessage = (ev) => {
          const msg = JSON.parse(String(ev.data)) as { type: 'hello'; data: DashboardSnapshot; user: TerminalState['user'] } | { type: 'batch'; events: EngineEvent[] };
          if (msg.type === 'hello') dispatch({ type: 'snapshot', data: msg.data, user: msg.user });
          else dispatch({ type: 'events', events: msg.events });
        };
        ws.onclose = () => {
          wsRef.current = null;
          if (stopped.current) return;
          setStream(retry.current > 4 ? 'offline' : 'reconnecting');
          schedule();
        };
        ws.onerror = () => ws.close();
      } catch {
        setStream(retry.current > 4 ? 'offline' : 'reconnecting');
        schedule();
      }
    };
    const schedule = () => {
      const delay = Math.min(15_000, 1000 * 2 ** retry.current++);
      timer = setTimeout(() => void connect(), delay);
    };
    void connect();
    return () => {
      stopped.current = true;
      if (timer) clearTimeout(timer);
      wsRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo<Ctx>(
    () => ({
      state,
      stream,
      viewMode,
      setViewMode,
      refresh,
      isAdmin: state.user?.role === 'admin',
      inspect,
      openCandidate: (id) => setInspect((x) => ({ ...x, candidateId: id })),
      openAgent: (id) => setInspect((x) => ({ ...x, agentId: id })),
      openPosition: (id) => setInspect((x) => ({ ...x, positionId: id })),
    }),
    [state, stream, viewMode, refresh, inspect],
  );
  return <TerminalContext.Provider value={value}>{children}</TerminalContext.Provider>;
}

export function useTerminal(): Ctx {
  const c = useContext(TerminalContext);
  if (!c) throw new Error('useTerminal outside TerminalProvider');
  return c;
}

/** Ticking clock for relative times. */
export function useNow(everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}
