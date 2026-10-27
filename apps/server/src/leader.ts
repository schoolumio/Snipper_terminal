import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';

/**
 * Single-writer guarantee across processes. Only the instance holding the
 * Redis lock runs the trading loop, so two deployments can never trade the
 * same wallet concurrently. Losing the lock stops trading immediately.
 */
export class LeaderLock {
  readonly id = randomUUID();
  private redis: Redis;
  private timer: NodeJS.Timeout | null = null;
  held = false;

  constructor(
    url: string,
    private readonly key = 'sniper:engine-leader',
    private readonly ttlMs = 15_000,
  ) {
    this.redis = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: true });
  }

  async connect(): Promise<void> {
    await this.redis.connect();
  }

  async acquire(): Promise<boolean> {
    const r = await this.redis.set(this.key, this.id, 'PX', this.ttlMs, 'NX');
    this.held = r === 'OK';
    return this.held;
  }

  /** Renew periodically; calls onLost if the lock is lost or Redis is unreachable. */
  keepAlive(onLost: (reason: string) => void): void {
    const renew = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;
    this.timer = setInterval(async () => {
      try {
        const ok = await this.redis.eval(renew, 1, this.key, this.id, String(this.ttlMs));
        if (ok !== 1) {
          this.held = false;
          onLost('leader lock taken by another instance');
        }
      } catch (e) {
        this.held = false;
        onLost(`redis unreachable: ${String(e)}`);
      }
    }, this.ttlMs / 3);
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async release(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    const del = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
    try {
      await this.redis.eval(del, 1, this.key, this.id);
    } finally {
      this.redis.disconnect();
    }
  }
}
