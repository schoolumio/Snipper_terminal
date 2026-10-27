import { DEFAULT_CONFIG, DEFAULT_HARD_LIMITS, Engine, PaperExecutionAdapter, SimulatedMarket } from '@sniper/core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate';
import { PostgresStore } from '../src/db/pg-store';

const URL = process.env.TEST_DATABASE_URL;

/**
 * Integration tests against a real PostgreSQL. Set TEST_DATABASE_URL to a
 * disposable database (it is wiped), e.g.
 *   TEST_DATABASE_URL=postgres://sniper:sniper@localhost:5432/sniper_test
 */
describe.skipIf(!URL)('PostgreSQL persistence', () => {
  let admin: pg.Pool;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: URL });
    await admin.query('drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;');
    await runMigrations(admin);
  });
  afterAll(async () => {
    await admin.end();
  });

  const engineFor = (store: PostgresStore, sim: SimulatedMarket, now: number) =>
    new Engine(
      {
        store,
        market: sim,
        quotes: sim,
        security: [sim],
        paperAdapter: new PaperExecutionAdapter({ chain: sim.chain, quotes: sim, venue: sim, failureRate: 0 }),
        liveAdapter: null,
        hardLimits: DEFAULT_HARD_LIMITS,
        defaultConfig: DEFAULT_CONFIG,
      },
      now,
    );

  it('persists positions, trades, ledger and audit across an engine restart', async () => {
    const t0 = Date.UTC(2026, 2, 1);
    const sim = new SimulatedMarket({ seed: 42, startAt: t0 - 30 * 60_000, failureRate: 0 });
    sim.advance(t0);
    const store1 = new PostgresStore(URL!);
    const e1 = engineFor(store1, sim, t0);
    await e1.init(t0);
    let t = t0;
    for (; t < t0 + 45 * 60_000; t += 1000) await e1.tick(t);
    const perf1 = e1.performanceFor('paper');
    const ledger1 = e1.ledger('paper');
    const open1 = e1.positionList().filter((p) => p.status !== 'closed');
    expect(perf1.trades).toBeGreaterThan(0);
    await e1.flush();
    await store1.close();

    const store2 = new PostgresStore(URL!);
    const e2 = engineFor(store2, sim, t + 1000);
    await e2.init(t + 1000);
    expect(e2.ledger('paper')).toEqual(ledger1);
    expect(e2.performanceFor('paper').trades).toBe(perf1.trades);
    expect(e2.positionList().filter((p) => p.status !== 'closed').map((p) => p.id).sort()).toEqual(open1.map((p) => p.id).sort());
    expect(e2.log.lastSeq).toBeGreaterThan(10);
    const trades = await store2.listTrades({ mode: 'paper', limit: 1000 });
    expect(trades.total).toBe(perf1.trades);
    const trail = await store2.listAudit({ correlationId: trades.rows[0]!.candidateId, limit: 500 });
    expect(trail.map((e) => e.action)).toEqual(expect.arrayContaining(['DISCOVERED', 'RISK_CHECK', 'ORDER_SUBMITTED', 'ENTRY_FILLED', 'EXIT_FILLED']));
    const search = await store2.listAudit({ search: 'DISCOVERED', limit: 5 });
    expect(search.length).toBeGreaterThan(0);
    await store2.close();
  }, 120_000);

  it('enforces the append-only audit log', async () => {
    await expect(admin.query(`update audit_log set reason = 'tampered' where seq = 1`)).rejects.toThrow(/append-only/);
    await expect(admin.query(`delete from audit_log where seq = 1`)).rejects.toThrow(/append-only/);
    await expect(admin.query(`truncate audit_log`)).rejects.toThrow(/append-only/);
    // The explicit retention opt-in works inside its own transaction.
    const c = await admin.connect();
    try {
      await c.query('begin');
      await c.query(`set local sniper.allow_audit_prune = 'on'`);
      const r = await c.query(`delete from audit_log where seq = -1`);
      expect(r.rowCount).toBe(0);
      await c.query('rollback');
    } finally {
      c.release();
    }
  });

  it('rejects duplicate idempotency keys at the database level', async () => {
    const r = await admin.query(`select data from orders limit 1`);
    const o = r.rows[0]?.data;
    expect(o).toBeTruthy();
    await expect(
      admin.query(`insert into orders (id, idempotency_key, mode, chain, purpose, side, candidate_id, token_address, amount_in, status, created_at, data) values ('dup', $1, 'paper', 'simnet', 'entry', 'buy', 'c', 't', 1, 'created', 0, '{}')`, [o.idempotencyKey]),
    ).rejects.toThrow(/duplicate key/);
  });

  it('stores decimals exactly', async () => {
    const r = await admin.query(`select cash::text as cash from trading_accounts where mode = 'paper'`);
    expect(r.rows[0].cash).toMatch(/^\d+\.\d{18}$/);
  });
});
