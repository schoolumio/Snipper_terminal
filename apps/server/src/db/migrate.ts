import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_IDS, AgentRegistry, STRATEGIES } from '@sniper/core';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type pg from 'pg';
import type { Role, User, UserRepo } from '../auth';
import { eq } from 'drizzle-orm';
import * as t from './schema';

export function migrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [process.env.MIGRATIONS_DIR, resolve(here, '../../drizzle'), resolve(here, '../drizzle'), resolve(process.cwd(), 'drizzle')].filter((x): x is string => !!x);
  const dir = candidates.find((c) => existsSync(resolve(c, 'meta/_journal.json')));
  if (!dir) throw new Error(`migrations folder not found (looked in ${candidates.join(', ')})`);
  return dir;
}

export async function runMigrations(pool: pg.Pool): Promise<void> {
  await migrate(drizzle(pool), { migrationsFolder: migrationsDir() });
}

/** Idempotent reference data: agents, strategy registry, paper wallet. */
export async function seedReference(pool: pg.Pool, now = Date.now()): Promise<void> {
  const db = drizzle(pool, { schema: t });
  const reg = new AgentRegistry(now, () => {});
  for (const id of AGENT_IDS) {
    const a = reg.get(id);
    await db.insert(t.agents).values({ id, name: a.name, role: a.role }).onConflictDoUpdate({ target: t.agents.id, set: { name: a.name, role: a.role } });
  }
  for (const s of Object.values(STRATEGIES)) {
    await db.insert(t.strategies).values({ id: s.id, version: s.version, label: s.label, registeredAt: now }).onConflictDoNothing();
  }
  await db.insert(t.wallets).values({ id: 'paper', chain: 'simnet', address: 'paper-ledger', label: 'Paper ledger (simulated)', mode: 'paper', allowed: true, createdAt: now }).onConflictDoNothing();
}

export class PgUserRepo implements UserRepo {
  private db;
  constructor(pool: pg.Pool) {
    this.db = drizzle(pool, { schema: t });
  }
  async findByUsername(username: string): Promise<User | null> {
    const [u] = await this.db.select().from(t.users).where(eq(t.users.username, username));
    return u ? { id: u.id, username: u.username, role: u.role as Role, passwordHash: u.passwordHash, disabled: u.disabled } : null;
  }
  async upsert(user: User): Promise<void> {
    await this.db
      .insert(t.users)
      .values({ id: user.id, username: user.username, passwordHash: user.passwordHash, role: user.role, createdAt: Date.now(), disabled: !!user.disabled })
      .onConflictDoUpdate({ target: t.users.username, set: { passwordHash: user.passwordHash, role: user.role, disabled: !!user.disabled } });
  }
}
