import type { AgentId, AgentState, AgentStatus } from '../types';

const META: Record<AgentId, { name: string; role: string }> = {
  scanner: { name: 'Scanner', role: 'discovers pools, tracks volume & liquidity — never trades' },
  risk: { name: 'Risk Guard', role: 'screens tokens; nothing executes without a non-REJECT verdict' },
  strategy: { name: 'Strategy', role: 'turns market data into scored, explainable signals' },
  sizer: { name: 'Sizer', role: 'sizes from equity & risk budget — never a fixed ticket' },
  executor: { name: 'Executor', role: 'sole order gateway: pre-trade checks, submit, confirm' },
  exit: { name: 'Exit Manager', role: 'stops, targets, trailing & time exits on executable quotes' },
  equity: { name: 'Accountant', role: 'ledger, equity curve, realized & unrealized P&L' },
  logger: { name: 'Audit Log', role: 'append-only record of every decision' },
  orchestrator: { name: 'Orchestrator', role: 'state machine, breakers, kill switch' },
};

export class AgentRegistry {
  private agents = new Map<AgentId, AgentStatus>();

  constructor(
    now: number,
    private readonly onChange: (s: AgentStatus) => void,
  ) {
    for (const [id, m] of Object.entries(META) as [AgentId, (typeof META)[AgentId]][]) {
      this.agents.set(id, {
        id,
        name: m.name,
        role: m.role,
        state: 'idle',
        currentTask: null,
        lastAction: null,
        lastDecision: null,
        lastUpdate: now,
        counters: {},
        errors: [],
        warning: null,
      });
    }
  }

  get(id: AgentId): AgentStatus {
    return this.agents.get(id)!;
  }

  all(): AgentStatus[] {
    return [...this.agents.values()].map((a) => ({ ...a, counters: { ...a.counters }, errors: [...a.errors] }));
  }

  update(id: AgentId, now: number, patch: Partial<Pick<AgentStatus, 'state' | 'currentTask' | 'lastAction' | 'lastDecision' | 'warning'>>): void {
    const a = this.agents.get(id)!;
    const changed = Object.entries(patch).some(([k, v]) => (a as unknown as Record<string, unknown>)[k] !== v);
    Object.assign(a, patch);
    a.lastUpdate = now;
    if (changed) this.onChange({ ...a });
  }

  count(id: AgentId, key: string, by = 1): void {
    const a = this.agents.get(id)!;
    a.counters[key] = (a.counters[key] ?? 0) + by;
  }

  error(id: AgentId, now: number, message: string): void {
    const a = this.agents.get(id)!;
    a.errors.unshift({ ts: now, message });
    if (a.errors.length > 20) a.errors.length = 20;
    a.state = 'error';
    a.lastUpdate = now;
    this.onChange({ ...a });
  }

  setState(id: AgentId, now: number, state: AgentState, warning: string | null = null): void {
    this.update(id, now, { state, warning });
  }
}
