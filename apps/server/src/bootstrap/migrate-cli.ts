import { createPool, migrate } from '../adapters/postgres/db.js';
import { readEnv } from './env.js';

const env = readEnv();
const pool = createPool(env.DATABASE_OWNER_URL);
await migrate(pool, console.log);
await pool.end();
console.log('migrations up to date');
