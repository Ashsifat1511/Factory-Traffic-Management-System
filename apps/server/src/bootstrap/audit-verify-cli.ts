import { createPool } from '../adapters/postgres/db.js';
import { Store } from '../adapters/postgres/store.js';
import { readEnv } from './env.js';

/** Recomputes every audit hash chain and reports the first broken link (plan §11.4). */
const env = readEnv();
const pool = createPool(env.DATABASE_OWNER_URL);
const store = new Store(pool);
const chains = (await pool.query('SELECT chain_id FROM audit_chain_heads ORDER BY chain_id')).rows.map((r) => r.chain_id as string);
let ok = true;
for (const c of chains) {
  const r = await store.verifyChain(c);
  console.log(`${c}: ${r.checked} entries, ${r.brokenAt === null ? 'intact' : `BROKEN at chain_seq ${r.brokenAt}`}`);
  if (r.brokenAt !== null) ok = false;
}
await pool.end();
process.exit(ok ? 0 : 1);
