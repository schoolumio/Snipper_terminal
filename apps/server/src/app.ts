import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import websocket from '@fastify/websocket';
import {
  AGENT_IDS,
  EngineError,
  runSimulatedBacktest,
  STRATEGY_IDS,
  type AuditEvent,
  type BacktestRunSummary,
  type Engine,
  type Store,
} from '@sniper/core';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors, jsonSchemaTransform, serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Auth, Principal, Role } from './auth';
import type { Env } from './env';
import { Gateway } from './ws/gateway';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

export interface AppDeps {
  env: Env;
  engine: Engine;
  store: Store;
  auth: Auth;
  /** Readiness probe for external dependencies (DB, leader lock). */
  ready?: () => Promise<{ ok: boolean; checks: Record<string, boolean> }>;
  logger?: boolean | object;
}

const SESSION_COOKIE = 'sniper_session';
const STATUS_BY_CODE: Record<EngineError['code'], number> = { invalid: 400, forbidden: 403, not_found: 404, conflict: 409, unavailable: 503 };

const Id = z.object({ id: z.string().min(1).max(128).regex(/^[\w:.-]+$/) });
const Mode = z.enum(['paper', 'live']);
const Limit = (def: number, maxV: number) => z.coerce.number().int().min(1).max(maxV).default(def);

export async function buildApp(deps: AppDeps) {
  const { env, engine, store, auth } = deps;
  const app = Fastify({
    logger: deps.logger ?? { level: env.LOG_LEVEL, redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'] },
    trustProxy: true,
    bodyLimit: 256 * 1024,
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest('principal', null);

  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' });
  await app.register(websocket, { options: { maxPayload: 4096 } });
  await app.register(swagger, {
    openapi: {
      info: { title: `${env.APP_NAME} API`, version: env.APP_VERSION, description: 'Multi-agent token pipeline, paper/live trading controls, accounting and audit. Authenticate with POST /api/auth/login (session cookie). Mutating requests require the header `x-sniper-csrf: 1`.' },
      components: { securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: SESSION_COOKIE } } },
      security: [{ session: [] }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  app.addHook('onRequest', async (req) => {
    req.principal = auth.session(req.cookies[SESSION_COOKIE]);
  });
  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cache-control', 'no-store');
  });
  // CSRF defence in depth (cookie is also SameSite=Strict).
  app.addHook('preHandler', async (req, reply) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    if (!req.url.startsWith('/api/')) return;
    if (req.headers['x-sniper-csrf'] !== '1') return reply.code(403).send({ error: 'missing CSRF header' });
  });

  app.setErrorHandler((err, req, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) return reply.code(400).send({ error: 'validation failed', details: err.validation.map((v) => ({ path: v.instancePath, message: v.message })) });
    if (err instanceof EngineError) return reply.code(STATUS_BY_CODE[err.code]).send({ error: err.message, code: err.code });
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.message });
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'internal error' });
  });

  const requireRole = (role: Role) => async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.principal) return reply.code(401).send({ error: 'authentication required' });
    if (role === 'admin' && req.principal.role !== 'admin') return reply.code(403).send({ error: 'admin role required' });
  };
  const viewer = { preHandler: requireRole('viewer') };
  const admin = { preHandler: requireRole('admin') };
  const who = (req: FastifyRequest) => req.principal?.username ?? 'unknown';

  // ───────────── health ─────────────
  app.get('/health', { schema: { tags: ['health'], security: [] } }, async () => ({ ok: true }));
  app.get('/ready', { schema: { tags: ['health'], security: [] } }, async (_req, reply) => {
    const st = engine.status();
    const ext = deps.ready ? await deps.ready() : { ok: true, checks: {} };
    const ok = ext.ok && st.running;
    return reply.code(ok ? 200 : 503).send({ ok, checks: { ...ext.checks, engineRunning: st.running } });
  });

  // ───────────── auth ─────────────
  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, schema: { tags: ['auth'], security: [], body: z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(256) }) } },
    async (req, reply) => {
      const r = await auth.login(req.body.username, req.body.password);
      if (!r) {
        req.log.warn({ username: req.body.username }, 'failed login');
        return reply.code(401).send({ error: 'invalid credentials' });
      }
      reply.setCookie(SESSION_COOKIE, r.token, { httpOnly: true, sameSite: 'strict', secure: env.COOKIE_SECURE, path: '/', maxAge: auth.sessionTtlMs / 1000 });
      return { username: r.principal.username, role: r.principal.role };
    },
  );
  app.post('/api/auth/logout', { schema: { tags: ['auth'] } }, async (req, reply) => {
    if (req.principal) auth.logout(req.principal);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
  app.get('/api/auth/me', { ...viewer, schema: { tags: ['auth'] } }, async (req) => ({ username: req.principal!.username, role: req.principal!.role }));
  app.post('/api/auth/ws-ticket', { ...viewer, schema: { tags: ['auth'], description: 'Single-use, 60s ticket for connecting to /ws?ticket=…' } }, async (req) => ({ ticket: auth.wsTicket(req.principal!) }));

  // ───────────── dashboard / status ─────────────
  app.get('/api/dashboard', { ...viewer, schema: { tags: ['dashboard'] } }, async () => engine.dashboard());
  app.get('/api/status', { ...viewer, schema: { tags: ['dashboard'] } }, async () => engine.status());
  app.get('/api/agents', { ...viewer, schema: { tags: ['agents'] } }, async () => engine.agents.all());
  app.get(
    '/api/agents/:id/events',
    { ...viewer, schema: { tags: ['agents'], params: z.object({ id: z.enum(AGENT_IDS as unknown as [string, ...string[]]) }), querystring: z.object({ limit: Limit(100, 1000), result: z.string().max(20).optional() }) } },
    async (req) => {
      const agent = engine.agents.get(req.params.id as never);
      const events = await store.listAudit({ agent: req.params.id, limit: req.query.limit, result: req.query.result });
      return { agent, events, errors: agent.errors };
    },
  );

  // ───────────── tokens / pipeline ─────────────
  app.get(
    '/api/tokens',
    {
      ...viewer,
      schema: {
        tags: ['pipeline'],
        querystring: z.object({
          stage: z.string().max(40).optional(),
          strategy: z.enum(STRATEGY_IDS).optional(),
          minLiquidity: z.coerce.number().min(0).optional(),
          maxRiskScore: z.coerce.number().min(0).max(100).optional(),
          maxAgeSec: z.coerce.number().min(0).optional(),
          q: z.string().max(64).optional(),
          limit: Limit(120, 500),
        }),
      },
    },
    async (req) => {
      const q = req.query;
      const now = engine.now;
      const stages = q.stage ? new Set(q.stage.split(',')) : null;
      return engine
        .candidateList(500)
        .filter((c) => (stages ? stages.has(c.stage) : true))
        .filter((c) => (q.strategy ? c.strategy === q.strategy : true))
        .filter((c) => (q.minLiquidity !== undefined ? Number(c.snapshot?.liquidity ?? 0) >= q.minLiquidity : true))
        .filter((c) => (q.maxRiskScore !== undefined ? (c.riskScore ?? 0) <= q.maxRiskScore : true))
        .filter((c) => (q.maxAgeSec !== undefined ? (now - c.pool.createdAt) / 1000 <= q.maxAgeSec : true))
        .filter((c) => (q.q ? c.pool.token.symbol.toLowerCase().includes(q.q.toLowerCase().replace(/^\$/, '')) || c.pool.token.address === q.q : true))
        .slice(0, q.limit);
    },
  );
  app.get('/api/tokens/:id', { ...viewer, schema: { tags: ['pipeline'], params: Id } }, async (req, reply) => {
    const live = engine.getCandidate(req.params.id);
    const candidate = live ?? (await store.getCandidate(req.params.id));
    if (!candidate) return reply.code(404).send({ error: 'candidate not found' });
    const [assessments, signals, proposals, sizing, audit, orders] = await Promise.all([
      store.getAssessments(candidate.id),
      store.getSignals(candidate.id),
      store.getProposals(candidate.id),
      store.getSizing(candidate.id),
      store.listAudit({ correlationId: candidate.id, limit: 500 }),
      store.getOrders({ candidateId: candidate.id }),
    ]);
    return { candidate, assessments, signals, proposals, sizing, orders, audit: audit.reverse(), history: engine.getHistory(candidate.pool.address).map((h) => ({ ts: h.ts, price: h.price, liquidity: h.liquidity, volume5m: h.volume.m5 })) };
  });

  app.get('/api/proposals/pending', { ...viewer, schema: { tags: ['pipeline'] } }, async () => engine.pendingApprovals());
  app.post('/api/proposals/:id/approve', { ...admin, schema: { tags: ['pipeline'], params: Id } }, async (req) => {
    await engine.decideProposal(req.params.id, true, who(req));
    return { ok: true };
  });
  app.post('/api/proposals/:id/reject', { ...admin, schema: { tags: ['pipeline'], params: Id } }, async (req) => {
    await engine.decideProposal(req.params.id, false, who(req));
    return { ok: true };
  });

  // ───────────── positions / orders / trades ─────────────
  app.get('/api/positions', { ...viewer, schema: { tags: ['positions'], querystring: z.object({ status: z.string().max(40).optional(), mode: Mode.optional() }) } }, async (req) =>
    engine.positionList().filter((p) => (req.query.status ? req.query.status.split(',').includes(p.status) : true) && (req.query.mode ? p.mode === req.query.mode : true)),
  );
  app.get('/api/positions/:id', { ...viewer, schema: { tags: ['positions'], params: Id } }, async (req, reply) => {
    const position = engine.getPosition(req.params.id) ?? (await store.getPosition(req.params.id));
    if (!position) return reply.code(404).send({ error: 'position not found' });
    const orders = await store.getOrders({ positionId: position.id, candidateId: position.candidateId });
    const [events, transactions, audit] = await Promise.all([store.getPositionEvents(position.id), store.getTransactions(orders.map((o) => o.id)), store.listAudit({ correlationId: position.candidateId, limit: 1000 })]);
    return { position, events, orders, transactions, audit: audit.reverse() };
  });
  app.post('/api/positions/:id/close', { ...admin, schema: { tags: ['positions'], params: Id } }, async (req) => {
    await engine.closePosition(req.params.id, who(req));
    return { ok: true };
  });
  app.post('/api/positions/:id/write-off', { ...admin, schema: { tags: ['positions'], params: Id, body: z.object({ confirm: z.literal('WRITE OFF') }) } }, async (req) => {
    await engine.writeOff(req.params.id, who(req));
    return { ok: true };
  });
  app.get('/api/orders', { ...viewer, schema: { tags: ['positions'] } }, async () => engine.orderList().slice(0, 200));
  app.get(
    '/api/trades',
    {
      ...viewer,
      schema: {
        tags: ['trades'],
        querystring: z.object({ mode: Mode.optional(), symbol: z.string().max(64).optional(), strategy: z.enum(STRATEGY_IDS).optional(), exitReason: z.string().max(40).optional(), from: z.coerce.number().int().optional(), to: z.coerce.number().int().optional(), limit: Limit(100, 1000), offset: z.coerce.number().int().min(0).default(0) }),
      },
    },
    async (req) => store.listTrades(req.query),
  );

  // ───────────── performance / equity ─────────────
  app.get('/api/performance', { ...viewer, schema: { tags: ['portfolio'] } }, async () => engine.performance());
  app.get('/api/equity', { ...viewer, schema: { tags: ['portfolio'], querystring: z.object({ mode: Mode.default('paper'), since: z.coerce.number().int().default(0), limit: Limit(2000, 10000) }) } }, async (req) =>
    store.persistent ? store.listEquity(req.query.mode, req.query.since, req.query.limit) : engine.equitySeries(req.query.mode).filter((e) => e.ts >= req.query.since).slice(-req.query.limit),
  );

  // ───────────── configuration ─────────────
  app.get('/api/config', { ...viewer, schema: { tags: ['config'] } }, async () => ({ version: engine.configVersion, config: engine.config, hardLimits: engine.hard }));
  app.put('/api/config', { ...admin, schema: { tags: ['config'], body: z.object({ config: z.unknown(), note: z.string().max(500).default('') }) } }, async (req) => engine.updateConfig(req.body.config, who(req), req.body.note));
  app.get('/api/config/versions', { ...viewer, schema: { tags: ['config'], querystring: z.object({ limit: Limit(20, 200) }) } }, async (req) => store.listConfigVersions(req.query.limit));

  // ───────────── controls ─────────────
  app.post('/api/control/pause', { ...admin, schema: { tags: ['control'], body: z.object({ paused: z.boolean() }) } }, async (req) => {
    await engine.setPaused(req.body.paused, who(req));
    return engine.status();
  });
  app.post('/api/control/kill-switch', { ...admin, schema: { tags: ['control'], body: z.object({ on: z.boolean(), confirm: z.string().optional() }) } }, async (req, reply) => {
    if (!req.body.on && req.body.confirm !== 'RELEASE') return reply.code(400).send({ error: 'releasing the kill switch requires confirm: "RELEASE"' });
    await engine.setKillSwitch(req.body.on, who(req));
    return engine.status();
  });
  app.get('/api/live', { ...viewer, schema: { tags: ['control'] } }, async () => {
    const st = engine.status();
    return { enabledByServer: env.LIVE_TRADING_ENABLED, adapterConfigured: st.liveAvailable, authorized: st.liveAuthorized, mode: st.mode, chain: st.chain, wallet: st.liveWallet, requiredConfirmation: 'ENABLE LIVE TRADING' };
  });
  app.post('/api/live/authorize', { ...admin, config: { rateLimit: { max: 5, timeWindow: '1 minute' } }, schema: { tags: ['control'], body: z.object({ confirm: z.string().max(64), walletLabel: z.string().max(128) }) } }, async (req) => {
    await engine.authorizeLive(req.body, who(req));
    return engine.status();
  });
  app.post('/api/live/revoke', { ...admin, schema: { tags: ['control'] } }, async (req) => {
    await engine.revokeLive(who(req));
    return engine.status();
  });
  app.post('/api/paper/:kind', { ...admin, schema: { tags: ['control'], params: z.object({ kind: z.enum(['deposit', 'withdraw']) }), body: z.object({ amount: z.string().regex(/^\d+(\.\d{1,8})?$/).refine((v) => Number(v) > 0 && Number(v) <= 1e9) }) } }, async (req) =>
    engine.adjustPaperBalance(req.params.kind, req.body.amount, who(req)),
  );

  // ───────────── alerts / audit ─────────────
  app.get('/api/alerts', { ...viewer, schema: { tags: ['alerts'], querystring: z.object({ limit: Limit(100, 500) }) } }, async (req) => (store.persistent ? store.listAlerts(req.query.limit) : engine.alertList().slice(0, req.query.limit)));
  app.post('/api/alerts/:id/ack', { ...viewer, schema: { tags: ['alerts'], params: Id } }, async (req) => {
    await engine.acknowledgeAlert(req.params.id);
    return { ok: true };
  });
  const AuditQuery = z.object({
    agent: z.string().max(20).optional(),
    result: z.string().max(20).optional(),
    correlationId: z.string().max(128).optional(),
    positionId: z.string().max(128).optional(),
    search: z.string().max(100).optional(),
    mode: Mode.optional(),
    from: z.coerce.number().int().optional(),
    to: z.coerce.number().int().optional(),
    beforeSeq: z.coerce.number().int().optional(),
    limit: Limit(200, 5000),
  });
  app.get('/api/audit', { ...viewer, schema: { tags: ['audit'], querystring: AuditQuery } }, async (req) => store.listAudit(req.query));
  app.get('/api/audit/export', { ...viewer, schema: { tags: ['audit'], querystring: AuditQuery.extend({ format: z.enum(['csv', 'jsonl']).default('csv') }) } }, async (req, reply) => {
    const rows = (await store.listAudit({ ...req.query, limit: Math.min(req.query.limit, 5000) })).reverse();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    if (req.query.format === 'jsonl') {
      reply.header('content-type', 'application/x-ndjson').header('content-disposition', `attachment; filename="audit-${stamp}.jsonl"`);
      return rows.map((r) => JSON.stringify(r)).join('\n');
    }
    reply.header('content-type', 'text/csv').header('content-disposition', `attachment; filename="audit-${stamp}.csv"`);
    return toCsv(rows);
  });

  // ───────────── backtests ─────────────
  let running: BacktestRunSummary | null = null;
  app.post(
    '/api/backtests',
    { ...admin, schema: { tags: ['backtest'], body: z.object({ seed: z.number().int().min(0).max(2 ** 31), durationSec: z.number().int().min(300).max(6 * 3600), startingEquity: z.string().regex(/^\d+(\.\d+)?$/).default('1000') }) } },
    async (req, reply) => {
      if (running) return reply.code(409).send({ error: 'a backtest is already running', id: running.id });
      const params = { ...req.body, config: engine.config, configVersion: engine.configVersion, hardLimits: engine.hard };
      const placeholder: BacktestRunSummary = { id: 'pending', createdAt: Date.now(), status: 'running', dataSource: 'simulated-market', seed: params.seed, durationSec: params.durationSec, configVersion: params.configVersion, stats: null, equityCurve: [], error: null, notes: '' };
      running = placeholder;
      void runSimulatedBacktest(params)
        .then(async ({ run, trades }) => {
          await store.saveBacktest(run, trades);
          req.log.info({ id: run.id, trades: trades.length }, 'backtest finished');
        })
        .catch((err: unknown) => req.log.error({ err }, 'backtest failed'))
        .finally(() => {
          running = null;
        });
      return reply.code(202).send({ status: 'running' });
    },
  );
  app.get('/api/backtests', { ...viewer, schema: { tags: ['backtest'] } }, async () => ({ running: running !== null, runs: await store.listBacktests(50) }));
  app.get('/api/backtests/:id', { ...viewer, schema: { tags: ['backtest'], params: Id } }, async (req, reply) => {
    const b = await store.getBacktest(req.params.id);
    return b ?? reply.code(404).send({ error: 'backtest not found' });
  });

  const gateway = new Gateway(engine, auth, env.corsOrigins);
  gateway.register(app);

  return { app, gateway };
}

const CSV_COLS: (keyof AuditEvent)[] = ['seq', 'ts', 'agent', 'action', 'result', 'mode', 'symbol', 'tokenAddress', 'positionId', 'sizeQuote', 'reason', 'correlationId', 'configVersion', 'strategyVersion'];

export function toCsv(rows: AuditEvent[]): string {
  const esc = (v: unknown) => {
    let x = v === null || v === undefined ? '' : String(v);
    // Neutralise spreadsheet formula injection.
    if (/^[=+\-@\t\r]/.test(x)) x = `'${x}`;
    return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x;
  };
  return [CSV_COLS.join(','), ...rows.map((r) => CSV_COLS.map((c) => (c === 'ts' ? new Date(r.ts).toISOString() : esc(r[c]))).join(','))].join('\n');
}
