import { describe, expect, it } from 'vitest';
import { d } from '../src/decimal';
import { MemoryStore } from '../src/store/memory-store';
import { FixtureMarket, makeEngine, runTicks, T0, testConfig } from './fixtures';

/** Drive one clean token from discovery to an open position. Returns the time reached. */
async function openPosition(engine: ReturnType<typeof makeEngine>['engine'], market: FixtureMarket, symbol = 'GOOD') {
  const pool = market.addPool(symbol, T0 + 5_000);
  const t = await runTicks(engine, T0, T0 + 80_000);
  return { pool, t };
}

describe('paper-trading lifecycle (end-to-end)', () => {
  it('discovers, screens, signals, sizes, enters, monitors, exits and accounts with a full audit trail', async () => {
    const { engine, market, store } = makeEngine();
    await engine.init(T0);
    const { pool, t } = await openPosition(engine, market);

    // 1-4. discovery, market evaluation, security assessment, signal
    const cand = engine.candidateList().find((c) => c.pool.address === pool.info.address)!;
    expect(cand).toBeTruthy();
    const stages = cand.stageHistory.map((h) => h.stage);
    // ELIGIBLE ⇄ SIGNAL_EVALUATION may repeat while the strategy waits for its conditions.
    expect(stages.slice(0, 4)).toEqual(['DISCOVERED', 'SCREENING', 'ELIGIBLE', 'SIGNAL_EVALUATION']);
    expect(stages.slice(-4)).toEqual(['TRADE_PROPOSED', 'RISK_APPROVED', 'EXECUTION_PENDING', 'OPEN']);
    expect(new Set(stages.slice(4, -4))).toEqual(new Set(stages.length > 8 ? ['ELIGIBLE', 'SIGNAL_EVALUATION'] : []));
    expect(cand.stage).toBe('OPEN');
    expect(cand.riskVerdict).toBe('PASS');
    // 5-7. sizing, approval, simulated entry
    const pos = engine.positionList()[0]!;
    expect(pos.status).toBe('open');
    expect(d(pos.costBasis).lte(40.1)).toBe(true); // 4% of 1000 + fee
    const ledger = engine.ledger('paper');
    expect(d(ledger.cash).toFixed(3)).toBe(d('1000').minus(pos.costBasis).toFixed(3));
    expect(ledger.reserved).toBe('0');

    // 8. monitoring marks the position on executable quotes
    await runTicks(engine, t + 1000, t + 5000);
    expect(engine.getPosition(pos.id)!.lastMark?.liquidationValue).toBeTruthy();

    // 9. exit: price +80% → take-profit 1 (50%) then take-profit 2 (rest)
    market.setPrice(pool, 0.0018);
    await runTicks(engine, t + 6000, t + 20_000);
    const closed = engine.getPosition(pos.id)!;
    expect(closed.status).toBe('closed');
    expect(closed.exitReason).toBe('take_profit');
    const events = await store.getPositionEvents(pos.id);
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['opened', 'exit_triggered', 'partial_exit', 'closed']));

    // 10. net P&L includes costs
    const trade = [...store.trades.values()][0]!;
    expect(d(trade.netPnl).gt(0)).toBe(true);
    expect(d(trade.grossPnl).minus(trade.fees).toFixed(6)).toBe(d(trade.netPnl).toFixed(6));
    expect(d(trade.fees).gt(0)).toBe(true);

    // 11. equity updated: cash = start + net pnl (no open positions left)
    const perf = engine.performanceFor('paper');
    expect(perf.trades).toBe(1);
    expect(perf.wins).toBe(1);
    expect(d(perf.equity).toFixed(6)).toBe(d('1000').plus(trade.netPnl).toFixed(6));
    expect(d(engine.ledger('paper').realizedPnl).toFixed(6)).toBe(d(trade.netPnl).toFixed(6));

    // 12. complete audit trail for the candidate
    const trail = (await store.listAudit({ correlationId: cand.id, limit: 500 })).reverse().map((e) => e.action);
    for (const a of ['DISCOVERED', 'RISK_CHECK', 'SIGNAL', 'SIZE', 'PRE_EXEC_CHECK', 'ORDER_SUBMITTED', 'ENTRY_FILLED', 'EXIT_TRIGGERED', 'PARTIAL_EXIT', 'EXIT_FILLED', 'PNL_RECONCILED']) expect(trail).toContain(a);
    expect(trail.indexOf('RISK_CHECK')).toBeLessThan(trail.indexOf('ORDER_SUBMITTED'));
    // every event carries the structured fields
    for (const e of store.audit) {
      expect(e.id).toBeTruthy();
      expect(typeof e.seq).toBe('number');
      expect(e.configVersion).toBe(1);
    }
  });

  it('closes at a loss through the stop and accounts the costs', async () => {
    const { engine, market, store } = makeEngine();
    await engine.init(T0);
    const { pool, t } = await openPosition(engine, market);
    market.setPrice(pool, 0.00082);
    await runTicks(engine, t + 1000, t + 10_000);
    const trade = [...store.trades.values()][0]!;
    expect(trade.exitReason).toBe('stop_loss');
    expect(d(trade.netPnl).lt(0)).toBe(true);
    expect(engine.performanceFor('paper').losses).toBe(1);
  });
});

describe('risk controls', () => {
  it('rejects a detected honeypot before any order', async () => {
    const { engine, market, store } = makeEngine();
    await engine.init(T0);
    market.addPool('HONEY', T0 + 5_000, { honeypot: true }, { sellSimulationOk: false });
    await runTicks(engine, T0, T0 + 80_000);
    const c = engine.candidateList()[0]!;
    expect(c.stage).toBe('REJECTED');
    expect(c.stageReason).toMatch(/sell simulation failed/);
    expect(store.orders.size).toBe(0);
  });

  it('rejects when security data is unavailable rather than treating it as safe', async () => {
    const { engine, market, store } = makeEngine();
    await engine.init(T0);
    market.securityOutage = true;
    market.addPool('DARK', T0 + 5_000);
    await runTicks(engine, T0, T0 + 80_000);
    expect(engine.candidateList()[0]!.stage).toBe('REJECTED');
    expect(store.orders.size).toBe(0);
  });

  it('flags an undetected honeypot as unsellable, values it at zero, and allows a write-off', async () => {
    const { engine, market, store } = makeEngine();
    await engine.init(T0);
    const { pool, t } = await openPosition(engine, market, 'TRAP');
    pool.honeypot = true;
    market.setPrice(pool, 0.0008);
    await runTicks(engine, t + 1000, t + 10_000);
    const p = engine.positionList()[0]!;
    expect(p.unsellable).toBe(true);
    expect(p.status).toBe('open');
    expect(engine.performanceFor('paper').unvaluedPositions).toBe(1);
    expect(engine.alertList().some((a) => a.kind === 'unsellable')).toBe(true);
    const wo = engine.writeOff(p.id, 'tester');
    await engine.tick(t + 11_000);
    await wo;
    expect(engine.getPosition(p.id)!.status).toBe('closed');
    const trade = [...store.trades.values()][0]!;
    expect(trade.txStatus).toBe('written_off');
    expect(d(engine.performanceFor('paper').equity).lt(1000)).toBe(true);
  });

  it('requires manual approval for REVIEW verdicts under the manual policy', async () => {
    const { engine, market } = makeEngine({ config: testConfig((c) => (c.risk.reviewPolicy = 'manual')) });
    await engine.init(T0);
    market.addPool('MAYBE', T0 + 5_000, {}, { mintAuthorityRenounced: null });
    await runTicks(engine, T0, T0 + 80_000);
    const pending = engine.pendingApprovals();
    expect(pending).toHaveLength(1);
    expect(engine.positionList()).toHaveLength(0);
    // Duplicate approvals cannot create duplicate orders.
    const a1 = engine.decideProposal(pending[0]!.id, true, 'alice');
    const a2 = engine.decideProposal(pending[0]!.id, true, 'bob');
    await engine.tick(T0 + 81_000);
    await expect(a1).resolves.toBeUndefined();
    await expect(a2).rejects.toThrow(/proposal is/);
    await runTicks(engine, T0 + 82_000, T0 + 84_000);
    expect(engine.positionList()).toHaveLength(1);
    expect(engine.orderList().filter((o) => o.purpose === 'entry')).toHaveLength(1);
  });
});

describe('circuit breakers & controls', () => {
  it('blocks entries when market data goes stale and recovers afterwards', async () => {
    const { engine, market } = makeEngine();
    await engine.init(T0);
    market.addPool('LATE', T0 + 5_000);
    market.outage = true;
    await runTicks(engine, T0, T0 + 80_000);
    expect(engine.status().breakers.find((b) => b.id === 'stale_data')!.tripped).toBe(true);
    expect(engine.status().breakers.find((b) => b.id === 'provider_health')!.tripped).toBe(true);
    expect(engine.entryBlockReason()).toMatch(/circuit breaker/);
    expect(engine.positionList()).toHaveLength(0);
    market.outage = false;
    await runTicks(engine, T0 + 81_000, T0 + 100_000);
    expect(engine.status().breakers.find((b) => b.id === 'stale_data')!.tripped).toBe(false);
    expect(engine.positionList()).toHaveLength(1);
  });

  it('kill switch blocks new entries and close_all exits open positions', async () => {
    const { engine, market } = makeEngine({ config: testConfig((c) => (c.risk.killSwitchPolicy = 'close_all')) });
    await engine.init(T0);
    const { t } = await openPosition(engine, market);
    const k = engine.setKillSwitch(true, 'tester');
    await engine.tick(t + 1000);
    await k;
    market.addPool('NEXT', t + 2000);
    await runTicks(engine, t + 2000, t + 90_000);
    const ps = engine.positionList();
    expect(ps).toHaveLength(1);
    expect(ps[0]!.status).toBe('closed');
    expect(ps[0]!.exitReason).toBe('emergency');
  });

  it('pauses after repeated execution failures and charges fees for failed transactions', async () => {
    const { engine, market } = makeEngine({ failureRate: 1, config: testConfig((c) => (c.trading.entryCooldownSec = 0)) });
    await engine.init(T0);
    for (const s of ['A1', 'A2', 'A3', 'A4', 'A5', 'A6']) market.addPool(s, T0 + 5_000);
    await runTicks(engine, T0, T0 + 120_000);
    const failed = engine.candidateList().filter((c) => c.stage === 'FAILED');
    expect(failed.length).toBeGreaterThan(0);
    expect(engine.positionList()).toHaveLength(0);
    const l = engine.ledger('paper');
    expect(l.reserved).toBe('0');
    expect(d(l.cash).lt(1000)).toBe(true);
    expect(d(l.realizedPnl).lt(0)).toBe(true);
  });

  it('trips the exit-quote breaker when an open position cannot be quoted', async () => {
    const { engine, market } = makeEngine();
    await engine.init(T0);
    const { t } = await openPosition(engine, market);
    market.quoteOutage = true;
    await runTicks(engine, t + 1000, t + 10_000);
    expect(engine.status().breakers.find((b) => b.id === 'exit_quotes')!.tripped).toBe(true);
    expect(engine.positionList()[0]!.lastMark?.quoteError).toBeTruthy();
    expect(engine.positionList()[0]!.status).toBe('open');
  });

  it('refuses live activation unless enabled, configured and confirmed', async () => {
    const { engine } = makeEngine();
    await engine.init(T0);
    await expect(engine.authorizeLive({ confirm: 'ENABLE LIVE TRADING', walletLabel: 'x' }, 'eve')).rejects.toThrow(/disabled/);
    expect(engine.mode).toBe('paper');
  });

  it('validates config updates against hard limits and versions them', async () => {
    const { engine, store } = makeEngine();
    await engine.init(T0);
    const loose = structuredClone(engine.config);
    loose.risk.maxDailyLossPct = '90';
    await expect(engine.updateConfig(loose, 'eve')).rejects.toThrow(/hard limit/);
    const ok = structuredClone(engine.config);
    ok.trading.maxConcurrentPositions = 2;
    ok.trading.exitPolicy.stopLossPct = '10';
    const p = engine.updateConfig(ok, 'alice');
    await engine.tick(T0 + 1000);
    await expect(p).resolves.toEqual({ version: 2 });
    expect(engine.config.trading.exitPolicy.version).toBe(2);
    expect(store.audit.some((e) => e.action === 'CONFIG_CHANGED' && e.reason.includes('maxConcurrentPositions'))).toBe(true);
  });
});

describe('persistence & recovery', () => {
  it('restores positions and ledger after a restart and keeps managing them', async () => {
    const store = new MemoryStore();
    const market = new FixtureMarket();
    const a = makeEngine({ store, market });
    await a.engine.init(T0);
    const { pool, t } = await openPosition(a.engine, market);
    const before = a.engine.positionList()[0]!;
    const cashBefore = a.engine.ledger('paper').cash;

    const b = makeEngine({ store, market, now: t + 5000 });
    await b.engine.init(t + 5000);
    expect(b.engine.mode).toBe('paper');
    expect(b.engine.positionList()[0]!.id).toBe(before.id);
    expect(b.engine.ledger('paper').cash).toBe(cashBefore);
    expect(b.engine.log.lastSeq).toBeGreaterThan(0);
    market.setPrice(pool, 0.0008);
    await runTicks(b.engine, t + 6000, t + 15_000);
    expect(b.engine.getPosition(before.id)!.status).toBe('closed');
  });

  it('resolves orders that were in flight when the process stopped', async () => {
    const store = new MemoryStore();
    const market = new FixtureMarket();
    const a = makeEngine({ store, market });
    await a.engine.init(T0);
    market.addPool('INFLIGHT', T0 + 5_000);
    // Stop exactly after submission, before the 500ms simulated fill.
    let t = T0;
    while (![...store.orders.values()].some((o) => o.status === 'submitted') && t < T0 + 90_000) await a.engine.tick((t += 1000));
    expect([...store.orders.values()].some((o) => o.status === 'submitted')).toBe(true);
    expect(d(a.engine.ledger('paper').reserved).gt(0)).toBe(true);

    const b = makeEngine({ store, market, now: t + 2000 });
    await b.engine.init(t + 2000);
    await b.engine.tick(t + 3000);
    const o = [...store.orders.values()][0]!;
    expect(o.status).toBe('failed');
    expect(b.engine.ledger('paper').reserved).toBe('0');
    expect(b.engine.ledger('paper').cash).toBe('1000');
    expect(b.engine.positionList()).toHaveLength(0);
  });
});
