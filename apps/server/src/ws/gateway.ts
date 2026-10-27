import type { Engine, EngineEvent } from '@sniper/core';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { Auth, Principal } from '../auth';

const FLUSH_MS = 250;
const MAX_BUFFERED = 4 * 1024 * 1024;

/** Event types where only the latest version per id matters within a flush window. */
const COALESCE: Partial<Record<EngineEvent['type'], (e: EngineEvent) => string>> = {
  candidate: (e) => `c:${(e.data as { id: string }).id}`,
  position: (e) => `p:${(e.data as { id: string }).id}`,
  agent: (e) => `a:${(e.data as { id: string }).id}`,
  order: (e) => `o:${(e.data as { id: string }).id}`,
  status: () => 'status',
  counters: () => 'counters',
  performance: () => 'performance',
};

/**
 * Real-time gateway. Clients authenticate with a single-use ticket from
 * POST /api/auth/ws-ticket; events are batched every 250ms and coalesced.
 */
export class Gateway {
  private clients = new Map<WebSocket, Principal>();
  private queue: EngineEvent[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly engine: Engine,
    private readonly auth: Auth,
    private readonly allowedOrigins: string[],
  ) {
    engine.onEvent((e) => this.queue.push(e));
  }

  register(app: FastifyInstance): void {
    app.get('/ws', { websocket: true, schema: { hide: true } }, (socket, req) => {
      const origin = req.headers.origin;
      if (origin && this.allowedOrigins.length && !this.allowedOrigins.includes(origin)) {
        socket.close(1008, 'origin not allowed');
        return;
      }
      const ticket = (req.query as { ticket?: string }).ticket;
      const principal = this.auth.redeemTicket(ticket);
      if (!principal) {
        socket.close(1008, 'unauthorized');
        return;
      }
      this.clients.set(socket, principal);
      socket.send(JSON.stringify({ type: 'hello', data: this.engine.dashboard(), user: { username: principal.username, role: principal.role } }));
      socket.on('close', () => this.clients.delete(socket));
      socket.on('error', () => this.clients.delete(socket));
      // Clients never send commands over the socket; ignore and drop abusive senders.
      let inbound = 0;
      socket.on('message', () => {
        if (++inbound > 50) socket.close(1008, 'unexpected messages');
      });
    });
    this.timer = setInterval(() => this.flush(), FLUSH_MS);
    app.addHook('onClose', async () => {
      if (this.timer) clearInterval(this.timer);
      for (const ws of this.clients.keys()) ws.close(1001, 'server shutting down');
    });
  }

  get clientCount(): number {
    return this.clients.size;
  }

  flush(): void {
    if (this.queue.length === 0) return;
    const events = this.queue;
    this.queue = [];
    if (this.clients.size === 0) return;
    const latest = new Map<string, EngineEvent>();
    const out: EngineEvent[] = [];
    for (const e of events) {
      const key = COALESCE[e.type]?.(e);
      if (key) latest.set(key, e);
      else out.push(e);
    }
    out.push(...latest.values());
    const msg = JSON.stringify({ type: 'batch', events: out });
    for (const ws of this.clients.keys()) {
      if (ws.bufferedAmount > MAX_BUFFERED) {
        ws.close(1013, 'client too slow');
        this.clients.delete(ws);
        continue;
      }
      if (ws.readyState === ws.OPEN) ws.send(msg);
    }
  }
}
