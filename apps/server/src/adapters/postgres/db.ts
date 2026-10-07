import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export type Pool = pg.Pool;
export type Client = pg.PoolClient;

export function createPool(url: string): Pool {
  return new pg.Pool({ connectionString: url, max: 10 });
}

export async function tx<T>(pool: Pool, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../migrations/', import.meta.url));

/** Applies migrations/*.sql in order; refuses to run if an applied file was edited. */
export async function migrate(ownerPool: Pool, log: (m: string) => void = () => undefined): Promise<void> {
  await ownerPool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  const applied = new Map<string, string>(
    (await ownerPool.query('SELECT name, checksum FROM schema_migrations')).rows.map((r) => [r.name, r.checksum]),
  );
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = readFileSync(MIGRATIONS_DIR + f, 'utf8');
    const sum = createHash('sha256').update(sql).digest('hex');
    const prev = applied.get(f);
    if (prev) {
      if (prev !== sum) throw new Error(`Migration ${f} was edited after being applied`);
      continue;
    }
    await tx(ownerPool, async (c) => {
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [f, sum]);
    });
    log(`applied ${f}`);
  }
}
