import { describe, expect, it } from 'vitest';
import { runSimulatedBacktest } from '../src/backtest/runner';
import { DEFAULT_CONFIG, DEFAULT_HARD_LIMITS } from '../src/config';
import { d } from '../src/decimal';
import { PaperExecutionAdapter } from '../src/execution/paper-adapter';
import { SimulatedMarket } from '../src/market/sim/simulated-market';
import { SolanaRpcSecurityProvider } from '../src/market/solana/rpc-security';
import { FixtureMarket, T0 } from './fixtures';

describe('paper execution adapter', () => {
  const setup = (failureRate = 0) => {
    const m = new FixtureMarket();
    const pool = m.addPool('X', T0);
    const a = new PaperExecutionAdapter({ chain: 'simnet', quotes: m, venue: m, failureRate, latencyMs: [1000, 1000] });
    const req = { idempotencyKey: 'k1', chain: 'simnet' as const, poolAddress: pool.info.address, tokenAddress: pool.info.token.address, side: 'buy' as const, amountIn: '40', minOut: '1', priorityFeeQuote: '0.002' };
    return { m, pool, a, req };
  };
  it('is idempotent on the idempotency key', async () => {
    const { a, req } = setup();
    const s1 = await a.submit(req, T0);
    const s2 = await a.submit(req, T0 + 10);
    expect(s2.txId).toBe(s1.txId);
  });
  it('models latency and settles with fees', async () => {
    const { a, req } = setup();
    const { txId } = await a.submit(req, T0);
    expect((await a.getStatus(txId, T0 + 500)).state).toBe('pending');
    const st = await a.getStatus(txId, T0 + 1000);
    expect(st.state).toBe('confirmed');
    if (st.state === 'confirmed') expect(st.networkFeeQuote).toBe('0.003');
  });
  it('enforces minOut at fill time when the price moved', async () => {
    const { a, req, m, pool } = setup();
    const q = await m.getQuote(req, T0);
    const { txId } = await a.submit({ ...req, minOut: d(q.expectedOut).times(0.99).toFixed() }, T0);
    m.setPrice(pool, 0.0012);
    const st = await a.getStatus(txId, T0 + 1000);
    expect(st.state).toBe('failed');
    if (st.state === 'failed') {
      expect(st.error).toMatch(/slippage/);
      expect(d(st.networkFeeQuote).gt(0)).toBe(true);
    }
  });
  it('reports unknown transactions instead of inventing outcomes', async () => {
    const { a } = setup();
    expect((await a.getStatus('nope', T0)).state).toBe('unknown');
    expect(await a.findByIdempotencyKey('missing', T0)).toBeNull();
  });
});

describe('simulated market', () => {
  it('is deterministic for a seed and labels itself simulated', async () => {
    const run = async () => {
      const m = new SimulatedMarket({ seed: 9, startAt: T0, failureRate: 0 });
      m.advance(T0 + 10 * 60_000);
      const pools = await m.discoverPools(0, T0 + 10 * 60_000);
      return pools.map((p) => p.token.symbol).join(',');
    };
    expect(await run()).toBe(await run());
    expect(new SimulatedMarket({ seed: 1 }).simulated).toBe(true);
  });
  it('round-trips state for retained pools', async () => {
    const m = new SimulatedMarket({ seed: 3, startAt: T0, failureRate: 0 });
    m.advance(T0 + 5 * 60_000);
    const pools = await m.discoverPools(0, T0 + 5 * 60_000);
    const keep = new Set([pools[0]!.address]);
    const m2 = new SimulatedMarket({ seed: 4, startAt: T0, failureRate: 0 });
    m2.restore(m.serialize(keep));
    const a = await m.getSnapshot(pools[0]!, T0 + 5 * 60_000);
    const b = await m2.getSnapshot(pools[0]!, T0 + 5 * 60_000);
    expect(b.price).toBe(a.price);
  });
});

describe('solana rpc security provider (mocked RPC)', () => {
  const MINT = 'So11111111111111111111111111111111111111112';
  const fakeFetch = (mintInfo: Record<string, unknown>) =>
    (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; id: number };
      const result =
        body.method === 'getAccountInfo'
          ? { value: { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: { parsed: { type: 'mint', info: mintInfo } } } }
          : body.method === 'getTokenSupply'
            ? { value: { amount: '1000000' } }
            : { value: [{ amount: '300000' }, { amount: '100000' }] };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200 });
    }) as typeof fetch;
  const pool = { address: 'p' } as never;

  it('reads mint / freeze authority and concentration', async () => {
    const p = new SolanaRpcSecurityProvider('https://rpc.example', fakeFetch({ mintAuthority: null, freezeAuthority: 'Abc', supply: '1000000', decimals: 6 }));
    const r = await p.assess('solana', MINT, pool, T0);
    expect(r.mintAuthorityRenounced).toBe(true);
    expect(r.freezeAuthorityRenounced).toBe(false);
    expect(r.top10HolderPct).toBe('40');
    expect(r.sellSimulationOk).toBeNull();
    expect(r.lpLock).toBeNull();
  });
  it('detects Token-2022 transfer fees and risky extensions', async () => {
    const p = new SolanaRpcSecurityProvider(
      'https://rpc.example',
      fakeFetch({ mintAuthority: null, freezeAuthority: null, extensions: [{ extension: 'transferFeeConfig', state: { newerTransferFee: { transferFeeBasisPoints: 250 } } }, { extension: 'permanentDelegate', state: {} }] }),
    );
    const r = await p.assess('solana', MINT, pool, T0);
    expect(r.transferTaxPct).toBe('2.5');
    expect(r.providerFlags).toContain('token2022:permanentDelegate');
  });
  it('rejects invalid input and other chains', async () => {
    const p = new SolanaRpcSecurityProvider('https://rpc.example', fakeFetch({}));
    await expect(p.assess('solana', 'not-a-mint!', pool, T0)).rejects.toThrow(/invalid mint/);
    await expect(p.assess('simnet', MINT, pool, T0)).rejects.toThrow(/unsupported chain/);
    expect(() => new SolanaRpcSecurityProvider('ftp://x')).toThrow();
  });
});

describe('simulated backtest', () => {
  it('runs the production pipeline in virtual time deterministically', async () => {
    const params = { seed: 11, durationSec: 1800, startingEquity: '1000', config: DEFAULT_CONFIG, configVersion: 1, hardLimits: DEFAULT_HARD_LIMITS };
    const a = await runSimulatedBacktest(params);
    const b = await runSimulatedBacktest(params);
    expect(a.run.status).toBe('completed');
    expect(a.run.stats!.trades).toBe(b.run.stats!.trades);
    expect(a.run.stats!.equity).toBe(b.run.stats!.equity);
    expect(a.run.equityCurve.length).toBeGreaterThan(10);
    // Accounting identity: equity = start + realized + unrealized (no deposits)
    const s = a.run.stats!;
    expect(d(s.equity).minus(s.startingEquity).minus(s.realizedPnl).minus(s.unrealizedPnl).abs().lt('0.00001')).toBe(true);
  }, 60_000);
});
