# Real-time events (WebSocket)

## Connecting

1. Sign in (session cookie).
2. `POST /api/auth/ws-ticket` (with `x-sniper-csrf: 1`) → `{ ticket }` — single use, valid 60 s.
3. Open `ws(s)://<api-host>/ws?ticket=<ticket>`. The `Origin` header must be listed in `CORS_ORIGINS`.

Invalid, reused or expired tickets and disallowed origins are closed with code **1008**. Slow consumers (> 4 MB buffered) are closed with **1013**. The server ignores client messages (commands go through the authenticated REST API) and closes connections that send more than 50.

## Messages (server → client)

```jsonc
// first message: the complete dashboard snapshot
{ "type": "hello", "data": DashboardSnapshot, "user": { "username": "admin", "role": "admin" } }

// then every 250 ms while anything changed
{ "type": "batch", "events": EngineEvent[] }
```

Within a batch, `candidate`, `position`, `agent`, `order`, `status`, `counters` and `performance` events are coalesced to the latest version per id; `audit`, `alert`, `equity` and `approval` events are delivered in order. Events queued before `hello` may be repeated — de-duplicate audit events by their monotonic `seq`.

| `type` | `data` | When |
| --- | --- | --- |
| `audit` | `AuditEvent` | every agent decision / state transition |
| `agent` | `AgentStatus` | agent state, task or decision changed |
| `candidate` | `Candidate` | pipeline stage or market snapshot changed |
| `position` | `Position` | opened, marked, stop moved, exit pending, closed |
| `order` | `Order` | submitted, confirmed, failed |
| `equity` | `EquitySnapshot` | periodic and on every close |
| `alert` | `Alert` | new or acknowledged |
| `approval` | `TradeProposal` | a proposal needs manual approval |
| `status` | `EngineStatus` | ~1/s: mode, health, breakers, providers |
| `counters` | `PipelineCounters` | ~1/s |
| `performance` | `{ paper, live }` | ~1/s |

All types are defined in `packages/core/src/types.ts`. Reconnect with exponential backoff; each new connection starts with a fresh `hello`, so clients never need to replay.
