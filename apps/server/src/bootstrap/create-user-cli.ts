import { createPool } from '../adapters/postgres/db.js';
import { Security } from '../adapters/postgres/security.js';
import { Store } from '../adapters/postgres/store.js';
import { createUserSchema } from '../contracts/schemas.js';
import { readEnv } from './env.js';

/** npm run create-user -- <username> <VIEWER|OPERATOR|ADMIN> [--simulation]   (password from FTMS_NEW_PASSWORD) */
const [username, role, flag] = process.argv.slice(2);
const parsed = createUserSchema.safeParse({ username, role, password: process.env.FTMS_NEW_PASSWORD, simulation_allowed: flag === '--simulation' });
if (!parsed.success) {
  console.error('usage: FTMS_NEW_PASSWORD=<at least 12 chars> npm run create-user -- <username> <VIEWER|OPERATOR|ADMIN> [--simulation]');
  for (const i of parsed.error.issues) console.error(`  ${i.path.join('.')}: ${i.message}`);
  process.exit(1);
}
const env = readEnv();
const pool = createPool(env.DATABASE_OWNER_URL);
const store = new Store(pool);
await new Security(pool, env.DEVICE_KEY_PEPPER, store).createUser(parsed.data.username, parsed.data.password, parsed.data.role, parsed.data.simulation_allowed);
await store.audit('SYSTEM', null, [{ type: 'SECURITY_EVENT', severity: 'SECURITY', details: { event: 'USER_CREATED', username: parsed.data.username, role: parsed.data.role, by: 'cli' } }], 'SYSTEM');
console.log(`user ${parsed.data.username} (${parsed.data.role}) saved`);
await pool.end();
