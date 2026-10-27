import {
  DEFAULT_CONFIG,
  Engine,
  MemoryStore,
  PaperExecutionAdapter,
  SimulatedMarket,
  type ExecutionAdapter,
  type SecurityProvider,
  type Store,
} from '@sniper/core';
import { Auth, generatePassword, hashPassword, MemoryUserRepo, type UserRepo } from './auth';
import { PostgresStore } from './db/pg-store';
import { PgUserRepo, runMigrations, seedReference } from './db/migrate';
import type { Env } from './env';

export interface Runtime {
  engine: Engine;
  store: Store;
  pg: PostgresStore | null;
  sim: SimulatedMarket | null;
  auth: Auth;
  warnings: string[];
  generatedAdminPassword: string | null;
}

export const SIM_STATE_KEY = 'simulated_market_state';

/**
 * Wires providers, adapters, storage and auth from the environment. Nothing
 * here starts trading: the engine always boots in PAPER mode and live mode
 * requires an explicit, authenticated authorization at runtime.
 */
export async function createRuntime(env: Env, now = Date.now()): Promise<Runtime> {
  const warnings: string[] = [];
  let pgStore: PostgresStore | null = null;
  let store: Store;
  let users: UserRepo;
  if (env.DATABASE_URL) {
    pgStore = new PostgresStore(env.DATABASE_URL);
    await pgStore.init();
    await runMigrations(pgStore.pool);
    await seedReference(pgStore.pool, now);
    store = pgStore;
    users = new PgUserRepo(pgStore.pool);
  } else {
    store = new MemoryStore();
    users = new MemoryUserRepo();
    warnings.push('DATABASE_URL not set — using in-memory storage; positions and audit events will NOT survive a restart');
  }

  // Users: environment is the source of truth for the bootstrap accounts.
  let generatedAdminPassword: string | null = null;
  const adminPassword = env.ADMIN_PASSWORD ?? (generatedAdminPassword = generatePassword());
  await users.upsert({ id: `usr_${env.ADMIN_USERNAME}`, username: env.ADMIN_USERNAME, role: 'admin', passwordHash: await hashPassword(adminPassword) });
  if (env.VIEWER_USERNAME && env.VIEWER_PASSWORD) await users.upsert({ id: `usr_${env.VIEWER_USERNAME}`, username: env.VIEWER_USERNAME, role: 'viewer', passwordHash: await hashPassword(env.VIEWER_PASSWORD) });
  const auth = new Auth(env.SESSION_SECRET, users);
  if (auth.ephemeralSecret) warnings.push('SESSION_SECRET not set — sessions are invalidated on restart');

  // Market data. Only the simulated provider ships ready to use; see docs/providers.md.
  const sim = new SimulatedMarket({ seed: env.SIM_SEED, launchEverySec: env.SIM_LAUNCH_EVERY_SEC, startAt: now - 5 * 60_000 });
  const persisted = await store.load();
  const simState = persisted.kv[SIM_STATE_KEY];
  if (simState) {
    try {
      sim.restore(simState);
    } catch (e) {
      warnings.push(`could not restore simulated market state: ${String(e)}`);
    }
  }
  sim.advance(now);
  const security: SecurityProvider[] = [sim];
  if (env.SOLANA_RPC_URL) warnings.push('SOLANA_RPC_URL is set but MARKET_PROVIDER=simulated: the Solana RPC security provider is only used with a Solana market provider');

  const paper = new PaperExecutionAdapter({ chain: sim.chain, quotes: sim, venue: sim, failureRate: env.PAPER_TX_FAILURE_RATE, seed: env.SIM_SEED ^ 0x9e3779b9 });
  // No live execution adapter ships enabled: see docs/providers.md (Solana / Jupiter adapter interface).
  const live: ExecutionAdapter | null = null;
  if (env.LIVE_TRADING_ENABLED && !live) warnings.push('LIVE_TRADING_ENABLED=true but no live execution adapter is configured — live mode stays unavailable');

  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.trading.chain = sim.chain;
  const engine = new Engine(
    {
      store,
      market: sim,
      quotes: sim,
      security,
      paperAdapter: paper,
      liveAdapter: live,
      hardLimits: env.hardLimits,
      defaultConfig: cfg,
      options: { name: env.APP_NAME, version: env.APP_VERSION, paperStartingEquity: env.PAPER_STARTING_EQUITY, liveTradingEnabled: env.LIVE_TRADING_ENABLED },
      clock: Date.now,
    },
    now,
  );
  await engine.init(now);
  return { engine, store, pg: pgStore, sim, auth, warnings, generatedAdminPassword };
}
