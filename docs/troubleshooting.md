# Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| UI stuck on "connecting to engine…" | API not reachable from Next. Check the server is up (`curl localhost:4000/health`) and `API_INTERNAL_URL`. |
| Redirected to /login repeatedly | Session cookie rejected. If `SESSION_SECRET` is unset, sessions die on every server restart. With HTTPS off, `COOKIE_SECURE` must be `false`. |
| `stream: reconnecting/offline` in the top bar | WebSocket blocked. Check `NEXT_PUBLIC_WS_URL` (default `ws://<host>:4000/ws`) and that the page origin is in `CORS_ORIGINS` (connections close with 1008 otherwise). |
| Server log: `generated one-time password` | `ADMIN_PASSWORD` not set — use the printed password or set one and restart. |
| `DATABASE_URL not set — using in-memory storage` | Nothing persists across restarts. Set `DATABASE_URL`. |
| `another instance holds the engine leader lock` | A second instance is running against the same Redis. Expected for standby; the lock expires 15 s after the leader stops. |
| No trades for a long time | Normal: most simulated launches are rejected (rugs, honeypots, concentration, wash trading) or never produce a qualifying signal. Check the *filtered* strip and the audit log for reasons; breakers or pause block entries (yellow banner). |
| Breaker `Market data freshness` tripped | Provider stopped returning data; entries are blocked until data resumes. |
| Breaker `Execution errors` tripped | Several failed or uncertain transactions in the window. Inspect `ENTRY_FAILED` / `RECONCILIATION_REQUIRED` events. Resets when the window passes. |
| Position flagged `unsellable` | Sell simulation or fills failed repeatedly (e.g. an honeypot that passed screening). It is valued at 0. Admins can write it off from the trade inspector. |
| `hard limit violation` when saving settings | The value exceeds a `HARD_MAX_*` environment limit. Raise the env limit deliberately (server restart) or lower the setting. |
| `chain … not served by configured market provider` | Config chain must match the market provider (the simulator serves `simnet`). |
| Live authorize returns 403/503 | `LIVE_TRADING_ENABLED` is false or no live adapter is configured — by design in this build. |
| PG tests skipped | Set `TEST_DATABASE_URL` to a disposable database (it is wiped). |
