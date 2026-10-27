import pg from 'pg';
import { runMigrations, seedReference } from './migrate';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: url });
try {
  await runMigrations(pool);
  await seedReference(pool);
  console.log('migrations applied');
} finally {
  await pool.end();
}
