import pg from 'pg';
import { generatePassword, hashPassword } from '../auth';
import { PgUserRepo, runMigrations, seedReference } from './migrate';

/**
 * Seeds reference data and (re)sets the admin user. Demo trading data is never
 * fabricated: run the engine in paper mode or a backtest to produce history.
 */
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: url });
try {
  await runMigrations(pool);
  await seedReference(pool);
  const username = process.env.ADMIN_USERNAME ?? 'admin';
  const password = process.env.ADMIN_PASSWORD ?? generatePassword();
  await new PgUserRepo(pool).upsert({ id: `usr_${username}`, username, role: 'admin', passwordHash: await hashPassword(password) });
  console.log(`seeded reference data; admin user "${username}"${process.env.ADMIN_PASSWORD ? '' : ` with generated password: ${password}`}`);
} finally {
  await pool.end();
}
