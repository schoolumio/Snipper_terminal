import { createHmac, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number }) => Promise<Buffer>;

export type Role = 'admin' | 'viewer';

export interface User {
  id: string;
  username: string;
  role: Role;
  passwordHash: string;
  disabled?: boolean;
}

export interface Principal {
  uid: string;
  username: string;
  role: Role;
  sid: string;
}

const N = 16384;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 32, { N, r: 8, p: 1 });
  return `scrypt$${N}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, nStr, saltB64, keyB64] = stored.split('$');
  if (alg !== 'scrypt' || !nStr || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64url');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64url'), expected.length, { N: Number(nStr), r: 8, p: 1 });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export interface UserRepo {
  findByUsername(username: string): Promise<User | null>;
  upsert(user: User): Promise<void>;
}

export class MemoryUserRepo implements UserRepo {
  private users = new Map<string, User>();
  async findByUsername(u: string) {
    return this.users.get(u) ?? null;
  }
  async upsert(user: User) {
    this.users.set(user.username, user);
  }
}

/**
 * Stateless HMAC-signed tokens for browser sessions (httpOnly cookie) and
 * single-use WebSocket tickets. Logout revokes the session id in memory.
 */
export class Auth {
  private readonly secret: Buffer;
  private revoked = new Map<string, number>();
  private usedTickets = new Map<string, number>();
  readonly sessionTtlMs = 12 * 3600_000;
  readonly ephemeralSecret: boolean;

  constructor(
    secret: string | undefined,
    readonly users: UserRepo,
  ) {
    this.ephemeralSecret = !secret;
    this.secret = secret ? Buffer.from(secret) : randomBytes(48);
  }

  private sign(payload: object): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const mac = createHmac('sha256', this.secret).update(body).digest('base64url');
    return `${body}.${mac}`;
  }

  private verify<T>(token: string | undefined): T | null {
    if (!token || token.length > 2048) return null;
    const [body, mac] = token.split('.');
    if (!body || !mac) return null;
    const expected = createHmac('sha256', this.secret).update(body).digest();
    const got = Buffer.from(mac, 'base64url');
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
    try {
      return JSON.parse(Buffer.from(body, 'base64url').toString()) as T;
    } catch {
      return null;
    }
  }

  async login(username: string, password: string): Promise<{ token: string; principal: Principal } | null> {
    const u = await this.users.findByUsername(username);
    // Always run a hash comparison to keep timing uniform for unknown users.
    const ok = await verifyPassword(password, u?.passwordHash ?? 'scrypt$16384$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    if (!u || !ok || u.disabled) return null;
    const principal: Principal = { uid: u.id, username: u.username, role: u.role, sid: randomUUID() };
    return { token: this.sign({ typ: 'session', ...principal, exp: Date.now() + this.sessionTtlMs }), principal };
  }

  session(token: string | undefined): Principal | null {
    const p = this.verify<Principal & { typ: string; exp: number }>(token);
    if (!p || p.typ !== 'session' || p.exp < Date.now() || this.revoked.has(p.sid)) return null;
    return { uid: p.uid, username: p.username, role: p.role, sid: p.sid };
  }

  logout(p: Principal): void {
    this.revoked.set(p.sid, Date.now() + this.sessionTtlMs);
    this.gc();
  }

  wsTicket(p: Principal): string {
    return this.sign({ typ: 'ws', jti: randomUUID(), uid: p.uid, username: p.username, role: p.role, sid: p.sid, exp: Date.now() + 60_000 });
  }

  /** Validates and consumes a WebSocket ticket. */
  redeemTicket(ticket: string | undefined): Principal | null {
    const t = this.verify<Principal & { typ: string; jti: string; exp: number }>(ticket);
    if (!t || t.typ !== 'ws' || t.exp < Date.now() || this.usedTickets.has(t.jti) || this.revoked.has(t.sid)) return null;
    this.usedTickets.set(t.jti, t.exp);
    this.gc();
    return { uid: t.uid, username: t.username, role: t.role, sid: t.sid };
  }

  private gc(): void {
    const now = Date.now();
    for (const [k, exp] of this.revoked) if (exp < now) this.revoked.delete(k);
    for (const [k, exp] of this.usedTickets) if (exp < now) this.usedTickets.delete(k);
  }
}

export function generatePassword(): string {
  return randomBytes(12).toString('base64url');
}
