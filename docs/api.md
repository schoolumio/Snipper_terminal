# HTTP API

Interactive OpenAPI documentation is served by the API at **`/docs`** (JSON at `/docs/json`); the web app proxies it at `http://localhost:3000/docs`.

## Conventions

* Authenticate with `POST /api/auth/login` → httpOnly, `SameSite=Strict` session cookie (12 h).
* Every non-GET request under `/api/` must send `x-sniper-csrf: 1`.
* Roles: `viewer` (read-only) and `admin` (controls, config, approvals, live).
* All inputs are validated with zod; invalid input → `400 { error, details }`.
* Engine errors map to `400 invalid`, `403 forbidden`, `404 not_found`, `409 conflict`, `503 unavailable`.
* Decimal values are strings (`"40.003"`); timestamps are epoch milliseconds.
* Global rate limit 600 req/min/IP; login 10/min; live authorization 5/min.

## Endpoints

| Method | Path | Role | Purpose |
| --- | --- | --- | --- |
| GET | `/health` | public | liveness |
| GET | `/ready` | public | readiness: DB, leader lock, engine loop |
| POST | `/api/auth/login` | public | `{username, password}` |
| POST | `/api/auth/logout` | any | revoke session |
| GET | `/api/auth/me` | viewer | current user |
| POST | `/api/auth/ws-ticket` | viewer | single-use 60 s WebSocket ticket |
| GET | `/api/dashboard` | viewer | full terminal snapshot |
| GET | `/api/status` | viewer | engine status, breakers, provider health |
| GET | `/api/agents` | viewer | agent statuses |
| GET | `/api/agents/:id/events` | viewer | recent decisions + error history |
| GET | `/api/tokens` | viewer | candidates; filters `stage,strategy,minLiquidity,maxRiskScore,maxAgeSec,q,limit` |
| GET | `/api/tokens/:id` | viewer | candidate + risk assessments + signals + proposals + sizing + orders + audit + price history |
| GET | `/api/proposals/pending` | viewer | proposals awaiting manual approval |
| POST | `/api/proposals/:id/approve` · `/reject` | admin | decide a pending proposal |
| GET | `/api/positions` | viewer | `status, mode` filters |
| GET | `/api/positions/:id` | viewer | position + events + orders + transactions + audit trail |
| POST | `/api/positions/:id/close` | admin | manual close (market sell via executor) |
| POST | `/api/positions/:id/write-off` | admin | `{confirm:"WRITE OFF"}` — only for positions flagged unsellable |
| GET | `/api/orders` | viewer | recent orders |
| GET | `/api/trades` | viewer | closed trades; `mode,symbol,strategy,exitReason,from,to,limit,offset` |
| GET | `/api/performance` | viewer | paper and live stats (never mixed) |
| GET | `/api/equity` | viewer | equity snapshots `mode,since,limit` |
| GET | `/api/config` | viewer | active config, version, hard limits |
| PUT | `/api/config` | admin | `{config, note}` — schema + hard-limit validated, versioned, audited |
| GET | `/api/config/versions` | viewer | history |
| POST | `/api/control/pause` | admin | `{paused}` — entries only; exits continue |
| POST | `/api/control/kill-switch` | admin | `{on}`; releasing requires `{on:false, confirm:"RELEASE"}` |
| GET | `/api/live` | viewer | live availability checklist |
| POST | `/api/live/authorize` | admin | `{confirm:"ENABLE LIVE TRADING", walletLabel}` |
| POST | `/api/live/revoke` | admin | return to paper |
| POST | `/api/paper/deposit` · `/withdraw` | admin | `{amount}` — paper ledger only, not P&L |
| GET | `/api/alerts` · POST `/api/alerts/:id/ack` | viewer | alerts |
| GET | `/api/audit` | viewer | `agent,result,correlationId,positionId,search,mode,from,to,beforeSeq,limit` |
| GET | `/api/audit/export` | viewer | same filters + `format=csv|jsonl` (≤ 5000 rows) |
| POST | `/api/backtests` | admin | `{seed, durationSec, startingEquity}` → 202 |
| GET | `/api/backtests` · `/api/backtests/:id` | viewer | runs and results |
