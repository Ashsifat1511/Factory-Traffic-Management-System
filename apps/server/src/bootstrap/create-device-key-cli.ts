import { createPool } from '../adapters/postgres/db.js';
import { Security } from '../adapters/postgres/security.js';
import { Store } from '../adapters/postgres/store.js';
import { createDeviceSchema } from '../contracts/schemas.js';
import { readEnv } from './env.js';

/**
 * npm run create-device-key -- <device_id> <SENSOR|CONTROLLER> <junction_id> [approach]
 * Issues (or rotates) a device key. The key is printed once; only its HMAC is stored.
 */
const [device_id, kind, junction_id, approach] = process.argv.slice(2);
const parsed = createDeviceSchema.safeParse({ device_id, kind, junction_id, ...(approach ? { approach } : {}) });
if (!parsed.success) {
  console.error('usage: npm run create-device-key -- <device_id> <SENSOR|CONTROLLER> <junction_id> [approach]');
  for (const i of parsed.error.issues) console.error(`  ${i.path.join('.')}: ${i.message}`);
  process.exit(1);
}
const env = readEnv();
const pool = createPool(env.DATABASE_OWNER_URL);
const store = new Store(pool);
const d = parsed.data;
const key = await new Security(pool, env.DEVICE_KEY_PEPPER, store).createDevice(d.device_id, d.kind, d.junction_id, d.approach ?? null);
await store.audit('SYSTEM', null, [{ type: 'SECURITY_EVENT', severity: 'SECURITY', details: { event: 'DEVICE_KEY_ISSUED', deviceId: d.device_id, by: 'cli' } }], 'SYSTEM');
console.log(key);
await pool.end();
