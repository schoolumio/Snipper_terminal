# Providers & chain adapters

The engine depends only on four interfaces (`packages/core/src/market/providers.ts`, `packages/core/src/execution/adapter.ts`). Swapping data sources or chains means implementing these, not touching agents.

| Interface | Responsibility |
| --- | --- |
| `MarketDataProvider` | `discoverPools(since, now)`, `getSnapshot(pool, now)`, optional `poll(now)`; declares `chain` and whether it is `simulated` |
| `QuoteProvider` | `getQuote({side, amountIn, pool, token})` → expected output, price impact, swap fee, network fee, expiry |
| `SecurityProvider` | `assess(chain, token, pool)` → `SecurityReport` (unknown = `null`). Several can be combined; `mergeSecurityReports` keeps the unsafe interpretation on conflicts and flags them |
| `ExecutionAdapter` | `simulate`, `submit` (idempotent on key), `getStatus`, `findByIdempotencyKey`, optional `getQuoteBalance`, `explorerUrl` |

Everything a provider returns is treated as untrusted: snapshots and quotes are validated (shape, identifiers, positive numbers, timestamps not in the future) before use, non-transient errors about one pool are not counted as an outage, and repeated failures trip the `provider_health` breaker.

## What ships in this repository

| Component | Status |
| --- | --- |
| `SimulatedMarket` | **Working.** Deterministic, seeded constant-product market with hidden archetypes (organic, runner, rug, honeypot, wash, dud), partially observable security data, LP pulls and sell restrictions. Implements market data, quotes, security and a swap venue. Clearly labelled *simulated* in API and UI. |
| `PaperExecutionAdapter` | **Working.** Latency, re-quote at fill time, minOut enforcement, random failures with fee charged, sell restrictions via the venue. |
| `SolanaRpcSecurityProvider` | **Implemented, unit-tested against mocked RPC responses; not exercised against a live RPC from this build environment.** Uses only standard Solana JSON-RPC methods (`getAccountInfo` jsonParsed, `getTokenSupply`, `getTokenLargestAccounts`) to read mint/freeze authority, Token-2022 transfer-fee config and risky extensions, and top-10 concentration. It cannot determine sellability, LP locks, deployer history or blacklists — those stay `null`. |
| Live Solana market data / quotes / execution | **Not implemented.** Interfaces only. See below. |

The build environment had no outbound access to DEX, aggregator or security-API hosts, so no third-party endpoint has been verified. Rather than ship guessed integrations, live adapters are left for you to implement against the provider's current documentation.

## Implementing Solana live trading

1. **Market data** (`MarketDataProvider`): a new-pool stream (e.g. a Geyser/websocket feed or a DEX-indexer API you subscribe to) plus per-pool snapshots (price, reserves → liquidity, 1m/5m/1h volume and buy/sell counts). Set `chain: 'solana'`, `simulated: false`.
2. **Quotes** (`QuoteProvider`): an aggregator or direct AMM math over on-chain reserves. Must return price impact and fees for the exact `amountIn`, plus an expiry.
3. **Security** (`SecurityProvider[]`): combine `SolanaRpcSecurityProvider` with a provider that can simulate a sell and report holder/deployer risk. Missing fields must be `null`, never guessed.
4. **Execution** (`ExecutionAdapter`, `mode: 'live'`):
   * build the swap transaction server side; run `simulateTransaction` in `simulate()`;
   * sign in an isolated signer (KMS/HSM or a separate signing service holding a restricted hot wallet); never load key material into the API process if avoidable, never log it;
   * map `idempotencyKey` → signature in durable storage so `findByIdempotencyKey` works after a restart;
   * `getStatus` must distinguish `pending`, `confirmed` (with actual in/out from the transaction's token balance deltas and the actual fee), `failed` (with fee) and `unknown` — never report success on submission alone;
   * `getQuoteBalance` returns the wallet's quote-asset balance; it initialises the live ledger.
5. Wire them in `apps/server/src/bootstrap.ts` (`market`, `quotes`, `security`, `liveAdapter`). Set `chain: 'solana'` in the config (the engine refuses a config whose chain differs from the market provider's).
6. Test on devnet / with dust amounts, keep `requireManualApprovalLive` on, and keep hard limits tight.

## External services and keys

| Variable | Needed for | Notes |
| --- | --- | --- |
| `DATABASE_URL` | persistence | PostgreSQL 14+ |
| `REDIS_URL` | leader election | optional for a single instance |
| `SOLANA_RPC_URL` | RPC security provider | a paid RPC is recommended for rate limits |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | notifications | optional; messages never include secrets and are labelled `[PAPER · simulated]` or `[LIVE]` |
