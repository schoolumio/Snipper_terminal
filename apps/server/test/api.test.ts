import { DEFAULT_CONFIG, Engine, MemoryStore, PaperExecutionAdapter, SimulatedMarket } from '@sniper/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildApp } from '../src/app';
import { Auth, hashPassword, MemoryUserRepo } from '../src/auth';
import { loadEnv } from '../src/env';

const SECRET = 'test-session-secret-that-is-long-enough-1234567890';
const ADMIN_PW = 'admin-password-123';
const VIEWER_PW = 'viewer-password-123';
const TG = '123456:TELEGRAM-SECRET-TOKEN';

async function setup() {
  const env = loadEnv({ NODE_ENV: 'test', SESSION_SECRET: SECRET, ADMIN_PASSWORD: ADMIN_PW, TELEGRAM_BOT_TOKEN: TG, CORS_ORIGINS: 'http://localhost:3000', LOG_LEVEL: 'silent' });
  const now = Date.now();
  const sim = new SimulatedMarket({ seed: 5, startAt: now - 10 * 60_000, failureRate: 0 });
  sim.advance(now);
  const store = new MemoryStore();
  const cfg = structuredClone(DEFAULT_CONFIG);
  const engine = new Engine({ store, market: sim, quotes: sim, security: [sim], paperAdapter: new PaperExecutionAdapter({ chain: sim.chain, quotes: sim, venue: sim }), liveAdapter: null, hardLimits: env.hardLimits, defaultConfig: cfg }, now);
  await engine.init(now);
  const users = new MemoryUserRepo();
  await users.upsert({ id: 'u1', username: 'admin', role: 'admin', passwordHash: await hashPassword(ADMIN_PW) });
  await users.upsert({ id: 'u2', username: 'viewer', role: 'viewer', passwordHash: await hashPassword(VIEWER_PW) });
  const auth = new Auth(SECRET, users);
  const { app } = await buildApp({ env, engine, store, auth, logger: false });
  return { app, engine, env };
}

type App = Awaited<ReturnType<typeof setup>>['app'];

async function login(app: App, username: string, password: string): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-sniper-csrf': '1' }, payload: { username, password } });
  expect(r.statusCode).toBe(200);
  const c = r.cookies.find((x) => x.name === 'sniper_session')!;
  expect(c.httpOnly).toBe(true);
  expect(c.sameSite).toBe('Strict');
  return `sniper_session=${c.value}`;
}

describe('API security', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let adminCookie: string;
  let viewerCookie: string;
  // A ticking loop so queued commands are processed.
  let loop: NodeJS.Timeout;

  beforeAll(async () => {
    ctx = await setup();
    loop = setInterval(() => void ctx.engine.tick(Date.now()), 50);
    adminCookie = await login(ctx.app, 'admin', ADMIN_PW);
    viewerCookie = await login(ctx.app, 'viewer', VIEWER_PW);
  });
  afterAll(async () => {
    clearInterval(loop);
    await ctx.app.close();
  });

  const csrf = { 'x-sniper-csrf': '1' };

  it('exposes health publicly but requires authentication elsewhere', async () => {
    expect((await ctx.app.inject({ url: '/health' })).statusCode).toBe(200);
    for (const url of ['/api/dashboard', '/api/status', '/api/config', '/api/trades', '/api/audit', '/api/positions']) {
      expect((await ctx.app.inject({ url })).statusCode).toBe(401);
    }
    expect((await ctx.app.inject({ url: '/api/dashboard', headers: { cookie: 'sniper_session=forged.token' } })).statusCode).toBe(401);
  });

  it('rejects bad credentials without revealing which part was wrong', async () => {
    const r1 = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', headers: csrf, payload: { username: 'admin', password: 'nope' } });
    const r2 = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', headers: csrf, payload: { username: 'ghost', password: 'nope' } });
    expect(r1.statusCode).toBe(401);
    expect(r1.body).toBe(r2.body);
  });

  it('requires the CSRF header on mutating requests', async () => {
    const r = await ctx.app.inject({ method: 'POST', url: '/api/control/pause', headers: { cookie: adminCookie }, payload: { paused: true } });
    expect(r.statusCode).toBe(403);
  });

  it('forbids viewers from administrative actions', async () => {
    for (const [method, url, payload] of [
      ['POST', '/api/control/pause', { paused: true }],
      ['POST', '/api/control/kill-switch', { on: true }],
      ['POST', '/api/live/authorize', { confirm: 'ENABLE LIVE TRADING', walletLabel: 'x' }],
      ['PUT', '/api/config', { config: DEFAULT_CONFIG }],
      ['POST', '/api/backtests', { seed: 1, durationSec: 600 }],
    ] as const) {
      const r = await ctx.app.inject({ method, url, headers: { cookie: viewerCookie, ...csrf }, payload });
      expect(r.statusCode, url).toBe(403);
    }
    expect((await ctx.app.inject({ url: '/api/dashboard', headers: { cookie: viewerCookie } })).statusCode).toBe(200);
  });

  it('refuses live activation when the server has not enabled it', async () => {
    const r = await ctx.app.inject({ method: 'POST', url: '/api/live/authorize', headers: { cookie: adminCookie, ...csrf }, payload: { confirm: 'ENABLE LIVE TRADING', walletLabel: 'any' } });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toMatch(/disabled/);
    expect(ctx.engine.mode).toBe('paper');
  });

  it('validates input and blocks hard-limit bypass attempts', async () => {
    const bad = await ctx.app.inject({ method: 'GET', url: '/api/trades?limit=99999999', headers: { cookie: adminCookie } });
    expect(bad.statusCode).toBe(400);
    const inj = await ctx.app.inject({ method: 'GET', url: "/api/tokens/'%20OR%201=1--", headers: { cookie: adminCookie } });
    expect(inj.statusCode).toBe(400);
    const loose = structuredClone(DEFAULT_CONFIG);
    loose.risk.maxPositionSizeQuote = '1000000';
    const r = await ctx.app.inject({ method: 'PUT', url: '/api/config', headers: { cookie: adminCookie, ...csrf }, payload: { config: loose } });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toMatch(/hard limit/);
    const malformed = await ctx.app.inject({ method: 'PUT', url: '/api/config', headers: { cookie: adminCookie, ...csrf }, payload: { config: { trading: { maxSlippagePct: 'NaN' } } } });
    expect(malformed.statusCode).toBe(400);
  });

  it('applies a valid config change and records it', async () => {
    const cfg = structuredClone(ctx.engine.config);
    cfg.trading.maxConcurrentPositions = 3;
    const r = await ctx.app.inject({ method: 'PUT', url: '/api/config', headers: { cookie: adminCookie, ...csrf }, payload: { config: cfg, note: 'test' } });
    expect(r.statusCode).toBe(200);
    const audit = await ctx.app.inject({ url: '/api/audit?search=CONFIG_CHANGED', headers: { cookie: adminCookie } });
    expect(audit.json()[0].action).toBe('CONFIG_CHANGED');
  });

  it('never leaks secrets in API responses', async () => {
    for (const url of ['/api/config', '/api/status', '/api/dashboard', '/api/live', '/api/agents']) {
      const body = (await ctx.app.inject({ url, headers: { cookie: adminCookie } })).body;
      expect(body).not.toContain(SECRET);
      expect(body).not.toContain(ADMIN_PW);
      expect(body).not.toContain(TG);
      expect(body).not.toMatch(/passwordHash|scrypt\$/);
    }
  });

  it('pause and kill switch require explicit confirmation to release', async () => {
    const on = await ctx.app.inject({ method: 'POST', url: '/api/control/kill-switch', headers: { cookie: adminCookie, ...csrf }, payload: { on: true } });
    expect(on.statusCode).toBe(200);
    expect(on.json().killSwitch).toBe(true);
    const off = await ctx.app.inject({ method: 'POST', url: '/api/control/kill-switch', headers: { cookie: adminCookie, ...csrf }, payload: { on: false } });
    expect(off.statusCode).toBe(400);
    const off2 = await ctx.app.inject({ method: 'POST', url: '/api/control/kill-switch', headers: { cookie: adminCookie, ...csrf }, payload: { on: false, confirm: 'RELEASE' } });
    expect(off2.json().killSwitch).toBe(false);
  });

  it('exports the audit log as CSV with formula-injection protection', async () => {
    const r = await ctx.app.inject({ url: '/api/audit/export?format=csv', headers: { cookie: adminCookie } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    expect(r.body.split('\n')[0]).toMatch(/^seq,ts,agent,action/);
  });

  it('serves an OpenAPI document', async () => {
    const r = await ctx.app.inject({ url: '/docs/json' });
    expect(r.statusCode).toBe(200);
    const doc = r.json();
    expect(doc.openapi).toMatch(/^3/);
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(['/api/dashboard', '/api/positions/{id}/close', '/api/live/authorize']));
  });

  it('logout revokes the session', async () => {
    const c = await login(ctx.app, 'viewer', VIEWER_PW);
    await ctx.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: c, ...csrf } });
    expect((await ctx.app.inject({ url: '/api/auth/me', headers: { cookie: c } })).statusCode).toBe(401);
  });
});

describe('WebSocket gateway', () => {
  it('requires a valid single-use ticket and streams engine events', async () => {
    const ctx = await setup();
    const loop = setInterval(() => void ctx.engine.tick(Date.now()), 100);
    try {
      await ctx.app.listen({ port: 0, host: '127.0.0.1' });
      const port = (ctx.app.server.address() as { port: number }).port;
      const cookie = await login(ctx.app, 'viewer', VIEWER_PW);
      const closeCode = (url: string) =>
        new Promise<number>((resolve) => {
          const ws = new WebSocket(url);
          ws.on('close', (code) => resolve(code));
          ws.on('error', () => {});
        });
      expect(await closeCode(`ws://127.0.0.1:${port}/ws`)).toBe(1008);
      expect(await closeCode(`ws://127.0.0.1:${port}/ws?ticket=bogus`)).toBe(1008);

      const { ticket } = (await ctx.app.inject({ method: 'POST', url: '/api/auth/ws-ticket', headers: { cookie, 'x-sniper-csrf': '1' } })).json();
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${ticket}`, { headers: { origin: 'http://localhost:3000' } });
      const types = await new Promise<string[]>((resolve, reject) => {
        const seen: string[] = [];
        ws.on('message', (raw) => {
          const m = JSON.parse(String(raw));
          seen.push(m.type);
          if (m.type === 'batch' && m.events.some((e: { type: string }) => e.type === 'status')) resolve(seen);
        });
        ws.on('error', reject);
        setTimeout(() => reject(new Error(`timeout; saw ${seen.join(',')}`)), 8000);
      });
      expect(types[0]).toBe('hello');
      expect(types).toContain('batch');
      ws.close();
      // Ticket is single use.
      expect(await closeCode(`ws://127.0.0.1:${port}/ws?ticket=${ticket}`)).toBe(1008);
      // Disallowed origin.
      const { ticket: t2 } = (await ctx.app.inject({ method: 'POST', url: '/api/auth/ws-ticket', headers: { cookie, 'x-sniper-csrf': '1' } })).json();
      const evil = await new Promise<number>((resolve) => {
        const w = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${t2}`, { headers: { origin: 'https://evil.example' } });
        w.on('close', (code) => resolve(code));
        w.on('error', () => {});
      });
      expect(evil).toBe(1008);
    } finally {
      clearInterval(loop);
      await ctx.app.close();
    }
  }, 20_000);
});
