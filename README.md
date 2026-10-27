# Sniper Terminal

A multi-agent token-launch trading system with a real-time operations console. Nine cooperating agents discover new liquidity pools, screen them for rug/honeypot risk, generate explainable signals, size positions from equity and risk budgets, execute through a single guarded gateway, manage exits on executable quotes, keep exact accounts, and write an append-only audit trail of every decision.

![Sniper Terminal](docs/screenshot.png)

> **Read this first.** This software does not and cannot guarantee profits. A risk `PASS` means configured checks found nothing disqualifying — not that a token is safe. Out of the box it runs in **paper mode** against a **deterministic simulated market**; everything shown is labelled *simulated*. **No live execution adapter ships with this build** (see [docs/providers.md](docs/providers.md)), so real orders are impossible until you implement and explicitly authorize one.

## What works today

| Area | Status |
| --- | --- |
| Agent pipeline (scanner → risk → strategy → sizer → executor → exit → accountant → audit, coordinated by an orchestrator state machine) | ✅ functional, unit + integration tested |
| Paper trading: latency, re-quote at fill, slippage caps, price impact, fees, failed transactions, sell restrictions | ✅ |
| Five strategies, versioned exit policies (stop, trailing, break-even, TP ladder w/ partial exits, time, momentum, liquidity) | ✅ |
| Portfolio risk: hard limits, exposure caps, daily-loss / drawdown / loss-streak / execution-error / stale-data / exit-quote breakers, kill switch | ✅ |
| Exact decimal accounting, separate paper/live ledgers, equity curve, performance analytics | ✅ |
| PostgreSQL persistence (atomic units of work, append-only audit trigger), restart recovery & reconciliation | ✅ tested against Postgres 16 |
| Fastify API (auth, roles, CSRF, rate limits, zod validation, OpenAPI at `/docs`), WebSocket stream | ✅ security-tested |
| Next.js terminal: live flow board, agent rail, trade inspector, equity/drawdown chart, live audit log w/ filters & CSV export, approvals, trade history, settings, backtests | ✅ |
| Event-driven backtester over the simulated market | ✅ deterministic |
| Solana RPC security signals (mint/freeze authority, Token-2022 fees, concentration) | ⚠️ implemented & tested against mocked RPC; not run against a live RPC here |
| Live Solana market data, quotes, signing & execution | ❌ interfaces only — requires a provider you choose ([guide](docs/providers.md)) |
| Telegram alerts | ⚠️ implemented, optional, unverified against Telegram from this environment |

## Quick start (local)

Requirements: Node 22+, pnpm 10, PostgreSQL 14+ (recommended), Redis (optional).

```bash
pnpm install
cp .env.example .env            # set ADMIN_PASSWORD and SESSION_SECRET; adjust DATABASE_URL
createdb sniper                 # or use docker compose up -d postgres redis
pnpm dev                        # API on :4000 (migrates on boot), web on :3000
```

Open <http://localhost:3000> and sign in with `ADMIN_USERNAME` / `ADMIN_PASSWORD`. Without `ADMIN_PASSWORD` the server prints a one-time generated password; without `DATABASE_URL` it runs in memory and warns that nothing persists.

The simulator launches a pool every ~25 s (`SIM_LAUNCH_EVERY_SEC`); most are rejected by the risk guard, so expect the first entries after a few minutes. Set `SIM_LAUNCH_EVERY_SEC=5` for a busier demo.

### Docker

```bash
cp .env.example .env            # set ADMIN_PASSWORD (≥12) and SESSION_SECRET (≥32)
docker compose up -d --build    # postgres, redis, server, web
```

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | API (tsx watch) + web (next dev) |
| `pnpm test` | all unit/integration tests (Postgres tests run when `TEST_DATABASE_URL` is set) |
| `pnpm typecheck` | strict TypeScript across packages |
| `pnpm build` | server bundle (`apps/server/dist`) + Next standalone build |
| `pnpm db:migrate` | apply migrations + reference data |
| `pnpm db:generate` | generate a migration after editing the Drizzle schema |
| `pnpm db:seed` | reference data + admin user (never fabricates trading history) |

```bash
TEST_DATABASE_URL=postgres://sniper:sniper@localhost:5432/sniper_test pnpm test
```

## Repository layout

```
.
├── packages/core/                 domain + engine (no framework / DB deps)
│   ├── src/types.ts               shared domain types (also used by the web app)
│   ├── src/config.ts              zod config schemas, defaults, hard-limit checks
│   ├── src/decimal.ts             decimal.js helpers (all money math)
│   ├── src/state-machine.ts       pipeline stages & allowed transitions
│   ├── src/engine.ts              orchestrator / supervisor (single writer)
│   ├── src/agents/                risk-guard, sizer, executor-checks, exit-manager,
│   │                              accountant, audit-logger, registry
│   ├── src/strategies/            five versioned strategies
│   ├── src/market/                provider interfaces, simulated market, Solana RPC security
│   ├── src/execution/             ExecutionAdapter interface, paper adapter
│   ├── src/store/                 Store interface, in-memory store
│   ├── src/backtest/              event-driven simulated backtest
│   └── test/                      unit, engine integration (full lifecycle), adapter tests
├── apps/server/                   Fastify API + WebSocket
│   ├── src/app.ts                 routes, auth guards, CSRF, OpenAPI
│   ├── src/ws/gateway.ts          ticketed, batched event stream
│   ├── src/db/                    Drizzle schema, PostgresStore, migrations, seed
│   ├── drizzle/                   SQL migrations (incl. append-only audit trigger)
│   ├── src/bootstrap.ts           providers/adapters/storage wiring
│   ├── src/leader.ts              Redis leader election
│   └── test/                      API security, WebSocket, Postgres persistence
├── apps/web/                      Next.js 16 terminal UI
│   ├── app/(terminal)/            terminal, trades, backtest, settings
│   ├── components/terminal/       agent rail, pipeline board, inspector, log, charts, sheets
│   ├── components/ui/             Radix-based primitives (shadcn-style)
│   └── lib/                       API client, WebSocket store, formatting
├── docker/                        server & web Dockerfiles
├── docker-compose.yml
└── docs/                          architecture, API, WebSocket, providers, security,
                                   deployment, troubleshooting
```

## How a trade happens

1. **Scanner** discovers a pool, dedupes it, snapshots market data and scores market quality.
2. **Risk Guard** merges security reports and returns PASS / REVIEW / REJECT with factors, sources and timestamps. Unknown critical data is never treated as safe.
3. **Strategy** evaluates enabled strategies on fresh data; the best qualifying signal carries its rationale, entry conditions, invalidation and exit policy.
4. **Sizer** computes the size as the minimum over every limit and re-quotes until price impact fits.
5. **Risk Guard** re-checks with the actual entry *and* exit quotes.
6. **Executor** runs 17 pre-trade checks, simulates, reserves funds, persists the order, submits, and confirms — or reconciles.
7. **Exit Manager** marks the position on executable sell quotes and exits by rule.
8. **Accountant** books fills, fees and P&L; **Audit Log** records every step. Click any token, position or log line in the UI to see the complete trail.

## Documentation

* [Architecture](docs/architecture.md) — agents, state machine, single-writer loop, persistence
* [HTTP API](docs/api.md) and [WebSocket events](docs/websocket.md) (OpenAPI at `/docs`)
* [Providers & chain adapters](docs/providers.md) — what's real, what's simulated, how to add Solana live trading
* [Security & trading safety](docs/security.md)
* [Deployment & operations](docs/deployment.md) · [Troubleshooting](docs/troubleshooting.md)
