# Deployment & operations

## Docker Compose (single host)

```bash
cp .env.example .env        # set SESSION_SECRET (≥32 chars) and ADMIN_PASSWORD (≥12 chars)
docker compose up -d --build
open http://localhost:3000   # sign in as ADMIN_USERNAME / ADMIN_PASSWORD
```

The server container runs migrations on start (`drizzle/`), seeds reference data and upserts the admin from the environment. Ports bind to `127.0.0.1`; put a TLS reverse proxy in front for remote access.

Build-time values for the web image: `API_INTERNAL_URL` (where Next proxies `/api`, default `http://server:4000`) and `NEXT_PUBLIC_WS_URL` (browser WebSocket URL). Rebuild the web image after changing them.

## Reverse proxy

Serve the web app and API on one origin, e.g. `https://sniper.example.com` → web:3000 and `wss://sniper.example.com/ws` → server:4000 (`Upgrade`/`Connection` headers forwarded). Then set:

```
COOKIE_SECURE=true
CORS_ORIGINS=https://sniper.example.com
NEXT_PUBLIC_WS_URL=wss://sniper.example.com/ws
NODE_ENV=production
```

## Production checklist

- [ ] `NODE_ENV=production` (the server refuses to start without `SESSION_SECRET` and a strong `ADMIN_PASSWORD`)
- [ ] PostgreSQL with backups; Redis for leader election if more than one instance can start
- [ ] HTTPS, `COOKIE_SECURE=true`, exact `CORS_ORIGINS`
- [ ] `HARD_MAX_*` limits reviewed — they cannot be raised from the UI
- [ ] `LIVE_TRADING_ENABLED=false` until a live adapter is implemented and validated in paper mode
- [ ] Alerts routed (Telegram) and someone watching them

## Migrations

```bash
pnpm db:migrate          # apply drizzle/ migrations + reference data
pnpm db:generate         # after editing apps/server/src/db/schema.ts
```

The server also applies pending migrations on boot. Migrations are forward-only; take a backup first.

## Backups & recovery

```bash
pg_dump -Fc "$DATABASE_URL" > sniper-$(date +%F).dump          # daily, keep off-host
pg_restore --clean --if-exists -d "$DATABASE_URL" sniper-2026-10-27.dump
```

After a restore, the engine boots in paper mode, restores open positions and ledgers, and reconciles orders that were in flight. Verify live wallet balances against the live ledger before re-authorizing live trading.

## Retention

* `market_snapshots` older than `SNAPSHOT_RETENTION_DAYS` (default 14) are pruned every 6 h.
* `audit_log` is never pruned automatically. To archive, export first, then in one transaction: `SET LOCAL sniper.allow_audit_prune = 'on'; DELETE FROM audit_log WHERE ts < …;`.

## Monitoring

* `GET /health` — process liveness; `GET /ready` — DB reachable, leader lock held, engine loop ticking (503 otherwise).
* Structured JSON logs (pino) on stdout; cookies and auth headers redacted.
* In-app: provider health, breakers, agent errors, alerts.

## Scaling

The trading loop is single-writer by design. Run one active instance; additional instances wait in standby on the Redis lock and take over within ~15 s of the leader disappearing. Losing the lock makes the leader stop trading and exit.
