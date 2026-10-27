import { attachNotifiers, TelegramNotifier, type Notifier } from './notify';
import { buildApp } from './app';
import { createRuntime, SIM_STATE_KEY } from './bootstrap';
import { loadEnv } from './env';
import { LeaderLock } from './leader';

const env = loadEnv();
const rt = await createRuntime(env);
const { engine, store, pg, sim, auth } = rt;

let leader: LeaderLock | null = null;
if (env.REDIS_URL) {
  leader = new LeaderLock(env.REDIS_URL);
  await leader.connect();
}

const { app } = await buildApp({
  env,
  engine,
  store,
  auth,
  ready: async () => {
    const checks: Record<string, boolean> = {};
    if (pg) checks.database = await pg.ping();
    if (leader) checks.leader = leader.held && (await leader.ping());
    return { ok: Object.values(checks).every(Boolean), checks };
  },
});
for (const w of rt.warnings) app.log.warn(w);
if (rt.generatedAdminPassword) app.log.warn(`ADMIN_PASSWORD not set — generated one-time password for "${env.ADMIN_USERNAME}": ${rt.generatedAdminPassword}`);

const notifiers: Notifier[] = [];
if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) notifiers.push(new TelegramNotifier(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID));
attachNotifiers(engine, notifiers, app.log);

// ── trading loop (single writer) ──
let loop: NodeJS.Timeout | null = null;
const startLoop = () => {
  loop = setInterval(() => void engine.tick(Date.now()), env.TICK_MS);
  app.log.info({ tickMs: env.TICK_MS, market: sim ? 'simulated' : 'external' }, 'trading loop started (PAPER mode)');
};
const stopLoop = (reason: string) => {
  if (loop) clearInterval(loop);
  loop = null;
  engine.pauseEntries(reason);
  app.log.error({ reason }, 'trading loop stopped');
};

if (leader) {
  const tryAcquire = async (): Promise<void> => {
    if (await leader!.acquire()) {
      leader!.keepAlive((reason) => {
        stopLoop(reason);
        // Fail safe: exit so a supervisor restarts us as a standby instance.
        setTimeout(() => process.exit(1), 500);
      });
      startLoop();
    } else {
      app.log.warn('another instance holds the engine leader lock — standing by');
      setTimeout(() => void tryAcquire(), 10_000);
    }
  };
  await tryAcquire();
} else {
  app.log.warn('REDIS_URL not set — assuming a single instance (no leader election)');
  startLoop();
}

// ── housekeeping ──
const persistSim = async () => {
  if (!sim || !store.persistent) return;
  await store.write({ kv: [{ key: SIM_STATE_KEY, value: sim.serialize(engine.retainedPools()) }] });
};
const housekeeping = setInterval(() => void persistSim().catch((e) => app.log.warn({ err: String(e) }, 'sim state persist failed')), 60_000);
const retention = setInterval(
  () =>
    void store
      .pruneSnapshots(Date.now() - env.SNAPSHOT_RETENTION_DAYS * 86_400_000)
      .then((n) => n && app.log.info({ removed: n }, 'pruned market snapshots'))
      .catch((e) => app.log.warn({ err: String(e) }, 'retention failed')),
  6 * 3600_000,
);

let shuttingDown = false;
const shutdown = async (sig: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ sig }, 'shutting down');
  if (loop) clearInterval(loop);
  clearInterval(housekeeping);
  clearInterval(retention);
  try {
    await engine.flush();
    await persistSim();
    await app.close();
    await leader?.release();
    await store.close();
  } finally {
    process.exit(0);
  }
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: env.HOST, port: env.PORT });
