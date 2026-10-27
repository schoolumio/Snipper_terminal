# Architecture

```
┌─────────────── apps/web (Next.js 16, React 19) ───────────────┐
│ Terminal · Trades · Backtest · Settings · Login                │
│ TerminalProvider: REST snapshot + WebSocket event stream       │
└───────────────▲───────────────────────────────▲───────────────┘
        /api/* (same-origin rewrite)      ws://…/ws?ticket=…
┌───────────────┴──────── apps/server (Fastify 5) ─┴─────────────┐
│ auth (scrypt, HMAC session cookie, WS tickets) · CSRF · rate    │
│ limits · zod validation · OpenAPI (/docs) · WebSocket gateway   │
│ leader lock (Redis) · retention · Telegram notifier             │
│                     ┌──────────── Engine ────────────┐          │
│                     │  orchestrator (single writer)   │          │
│                     │  scanner → risk → strategy →    │          │
│                     │  sizer → executor → exit mgr →  │          │
│                     │  accountant · audit logger      │          │
│                     └──┬──────────┬──────────┬────────┘          │
│        MarketDataProvider  SecurityProvider[]  ExecutionAdapter  │
│        QuoteProvider       (merged, untrusted) (paper | live)    │
│                     Store (PostgresStore | MemoryStore)          │
└─────────────────────────────────────────────────────────────────┘
                     packages/core (pure TypeScript)
```

## Packages

| Path | Contents |
| --- | --- |
| `packages/core` | Domain types, config schemas, decimal math, every agent, the orchestrator, the state machine, simulated market, paper execution, backtester, `Store` interface and an in-memory store. No framework or database dependencies. |
| `apps/server` | Fastify HTTP/WebSocket API, PostgreSQL store (Drizzle), migrations, auth, leader lock, notifications, bootstrap. |
| `apps/web` | Next.js terminal UI. Imports only `@sniper/core/types` and `@sniper/core/config` — no engine code ships to the browser. |

## Single-writer orchestration

`Engine.tick(now)` is the only place state changes. API commands (close, approve, config change, kill switch…) are queued with `engine.command()` and executed at the start of the next tick. This removes races on the same token, wallet, order or position without fine-grained locks. Across processes the Redis leader lock (`apps/server/src/leader.ts`) guarantees only one instance runs the loop; losing the lock stops trading and exits the process.

A tick:

1. run queued commands
2. advance providers (`poll`) and discover new pools (scanner)
3. refresh snapshots for due candidates (bounded per tick)
4. advance candidates through the pipeline (bounded per tick)
5. poll in-flight orders (confirm / fail / reconcile)
6. exit manager: mark open positions on executable sell quotes, evaluate rules, submit exits
7. circuit breakers, equity snapshot, garbage collection
8. flush the unit of work to the store **atomically** (one DB transaction)

## Pipeline state machine

```
DISCOVERED → SCREENING → REJECTED | ELIGIBLE
ELIGIBLE ⇄ SIGNAL_EVALUATION → TRADE_PROPOSED → RISK_APPROVED → EXECUTION_PENDING → OPEN → EXIT_PENDING → CLOSED
                                     ↘ ELIGIBLE (deferred: portfolio limits / executor pre-checks)
EXIT_PENDING → OPEN (partial exit or failed sell)
any in-flight → RECONCILIATION_REQUIRED (uncertain transaction outcome)
terminal: REJECTED · CLOSED · EXPIRED · FAILED · CANCELLED
```

Transitions are declared in `packages/core/src/state-machine.ts`; anything else throws `InvalidTransitionError`, so no agent can skip a stage.

## Agents

| Agent | Module | What it actually does |
| --- | --- | --- |
| Scanner | `engine.ts` (discover/refresh) + `risk-guard.ts#scannerScore` | Dedupes pools by address and token, keeps a ring buffer of snapshots per pool, validates provider data, computes a market-quality score, applies the min-age / min-liquidity gate. Never trades. |
| Risk Guard | `agents/risk-guard.ts` | Deterministic checks over merged security reports and market data → `PASS / REVIEW / REJECT`, risk score, data confidence, factor list with sources and timestamps. Re-runs on every evaluation and again immediately before execution with the real entry and exit quotes. |
| Strategy | `strategies/index.ts` | Five versioned strategies (new-pool entry, volume spike, breakout, pullback, liquidity+momentum). Each returns a scored signal with rationale, entry conditions and invalidation, or a skip reason. Highest qualifying score wins. |
| Sizer | `agents/sizer.ts` | Minimum over equity %, risk budget at the stop (incl. costs), absolute cap, per-token / total / new-launch exposure, cash after fee reserve, pool-liquidity participation, remaining daily-loss budget, then a price-impact re-quote loop. Reports the binding constraint. |
| Executor | `agents/executor-checks.ts` + `engine.ts#executeEntry` | The only component holding an `ExecutionAdapter`. Runs 17 pre-trade checks, transaction simulation, reserves funds, persists the order *before* submitting, then tracks confirmation. Idempotency keys; never blindly retries; uncertain outcomes → reconciliation. |
| Exit Manager | `agents/exit-manager.ts` | Marks positions on the executable sell quote; stop loss, trailing stop, break-even, take-profit ladder (partial exits), time stop, momentum reversal, liquidity deterioration, manual, emergency. Flags unsellable positions. |
| Accountant | `agents/accountant.ts` | Separate paper / live ledgers, reservations, fills, failed-tx fees, deposits / withdrawals (never P&L), liquidation-value equity, drawdown, performance stats. |
| Audit Log | `agents/audit-logger.ts` | Sequenced, append-only events with correlation ids, config and strategy versions; secret-pattern redaction; persisted in the same transaction as the state change. |
| Orchestrator | `engine.ts` | State machine, queues, budgets per tick, circuit breakers, kill switch, pause, live authorization. |

No language model is involved in any trade-critical decision. Every price, balance and quote comes from a provider or from deterministic arithmetic (`decimal.js`, 40 significant digits).

## Money

All amounts are decimal strings (`Dec`) in the domain model and `NUMERIC(38,18)` in PostgreSQL. `number` is used only for display and for unit-less strategy scores. The simulated market's internal dynamics use floats, but every quote and fill it returns is computed with `Decimal`.

## Persistence

`Store.write(batch)` is atomic. The engine accumulates a `WriteBatch` per tick/command and flushes it in one transaction; entry orders are flushed *before* submission so a crash cannot lose an in-flight order. On restart `Store.load()` restores config, ledgers, positions, pending orders (which are reconciled), recent audit events, trades and equity snapshots. Candidates that were mid-evaluation are expired — stale quotes are never acted on. Live mode is never restored automatically.
