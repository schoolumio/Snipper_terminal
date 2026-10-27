# Security & trading safety

## No promises

Nothing in this system predicts profitable trades. A risk `PASS` means the configured checks found nothing disqualifying — never that a token is safe. Results from the simulator or a backtest describe a synthetic market and are not evidence of real-world profitability.

## Live trading is opt-in, every time

Live orders require **all** of:

1. `LIVE_TRADING_ENABLED=true` in the server environment;
2. a configured live `ExecutionAdapter` (none ships — see `providers.md`);
3. an authenticated **admin** calling `POST /api/live/authorize` with the phrase `ENABLE LIVE TRADING` and re-typing the configured wallet label;
4. per-trade manual approval while `requireManualApprovalLive` is on (default).

Authorization is held in memory only: deploys, restarts, config reloads and reconnects always come back in **paper** mode. Paper and live use separate ledgers, positions and metrics.

## Layers of protection on every order

* **Hard limits** from environment variables (`HARD_MAX_*`). Config updates exceeding them are rejected (`403`) and every sizing / execution computation also clamps to them.
* **Risk Guard** at screening, on every re-evaluation, and again pre-execution with the real entry and exit quotes. Unknown critical data → `REVIEW`/`REJECT`. Unverified LP-lock claims count as unlocked.
* **Sizer**: equity allocation is an upper bound; also capped by risk budget, exposure, cash, liquidity, daily-loss budget, then price impact.
* **Executor**: 17 pre-trade checks (mode, kill switch, breakers, proposal validity & expiry, identifiers, data freshness, risk recheck age, balance, portfolio limits recomputed now, fresh quote, price impact, max entry price, network fee, slippage minOut, duplicates, authorization) + transaction simulation; idempotency keys (unique in the DB); funds reserved and order persisted before submission.
* **Circuit breakers**: stale market data, provider health, daily loss, drawdown, consecutive losses (cooldown), execution-error rate, missing exit quotes. Any tripped breaker blocks new entries.
* **Kill switch**: blocks new orders immediately and cancels pending proposals. Position handling follows `killSwitchPolicy`: `exits_only` (default), `close_all`, or `block_all`.
* **Reconciliation**: an uncertain submission or confirmation timeout moves the order/position to `RECONCILIATION_REQUIRED`; nothing is retried blindly. Paper orders lost to a restart are resolved as never filled; live orders stay flagged with a critical alert until resolved.

Stops and targets are enforced by this application, not on-chain. They act only while the engine runs, has a quote and can land a sell. Honeypots that pass screening are detected when exits fail; such positions are valued at zero and can be written off explicitly.

## Secrets

* Signing keys, RPC credentials and provider keys are server-side environment variables only; nothing secret uses a `NEXT_PUBLIC_` prefix and the browser never receives secrets (covered by tests).
* The app never asks for or stores seed phrases.
* Audit text is passed through a redactor for key-like material (base58 64-byte keys, 32-byte hex, JSON byte arrays). Logs redact cookies and authorization headers.

## Authentication & API hardening

* Passwords hashed with scrypt (N=16384); timing-uniform login; 10 attempts/min/IP.
* Session: HMAC-SHA256-signed, httpOnly, `SameSite=Strict`, 12 h; logout revokes. Set `COOKIE_SECURE=true` behind HTTPS.
* CSRF: custom header required on every mutating request in addition to SameSite.
* WebSocket: single-use 60 s tickets, origin allow-list, inbound messages ignored, backpressure limit.
* Roles: viewer (read-only) vs admin; enforced server side on every route.
* zod validation on every body/query/param; body limit 256 kB; global rate limit; security headers (`nosniff`, `DENY` framing, `no-referrer`, `no-store`).
* CSV export neutralises spreadsheet formula injection.

## Audit integrity

`audit_log` is append-only: a PostgreSQL trigger rejects `UPDATE`, `TRUNCATE` and `DELETE` (a retention job must explicitly `SET LOCAL sniper.allow_audit_prune = 'on'` in its own transaction). Events are sequenced and written in the same transaction as the state change they describe. Every config change is versioned with author and note.

## Operational risks to understand

* Provider data can be wrong or manipulated; MEV/sandwiching and congestion can make fills far worse than quotes.
* Newly launched tokens frequently lose most of their value; liquidity can disappear between quote and fill.
* A hot wallet with withdrawal rights is a single point of failure — keep balances small and use spending limits.
* Running two instances against one wallet without Redis leader election can double-trade.
