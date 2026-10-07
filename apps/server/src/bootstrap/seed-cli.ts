import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { configFromJson } from '@ftms/domain';
import { createPool, migrate } from '../adapters/postgres/db.js';
import { Security } from '../adapters/postgres/security.js';
import { Store } from '../adapters/postgres/store.js';
import { readEnv } from './env.js';

/** Seeds junction configs, demo users and device keys (plan §11.6). */
const env = readEnv();
const owner = createPool(env.DATABASE_OWNER_URL);
await migrate(owner, console.log);
const store = new Store(owner);
const security = new Security(owner, env.DEVICE_KEY_PEPPER, store);

const dir = new URL('../../../../config/junctions/', import.meta.url);
for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
  const cfg = configFromJson(JSON.parse(readFileSync(new URL(f, dir), 'utf8')));
  console.log(`junction ${cfg.junctionId}: ${(await store.createJunction(cfg, 'seed')) ? 'created' : 'already exists'}`);
}

for (const [name, role, sim] of [['admin', 'ADMIN', true], ['operator', 'OPERATOR', true], ['viewer', 'VIEWER', false]] as const) {
  const pw = process.env[`SEED_${name.toUpperCase()}_PASSWORD`];
  if (!pw) { console.error(`SEED_${name.toUpperCase()}_PASSWORD is not set; skipping user ${name}`); continue; }
  await security.createUser(name, pw, role, sim);
  console.log(`user ${name} (${role})`);
}

const lines: string[] = [];
const { rows } = await owner.query('SELECT junction_id FROM junctions');
for (const { junction_id: j } of rows) {
  const ctrlKey = await security.createDevice(`ctrl-${j}`, 'CONTROLLER', j, null);
  lines.push(`CONTROLLER_KEY_${j}=${ctrlKey}`);
  for (const a of ['NORTH', 'SOUTH', 'EAST', 'WEST']) {
    const k = await security.createDevice(`sensor-${j}-${a}`, 'SENSOR', j, a);
    lines.push(`SENSOR_KEY_${j}_${a}=${k}`);
  }
}
writeFileSync(new URL('../../../../.sim-keys.env', import.meta.url), `${lines.join('\n')}\n`);
console.log('device keys written to .sim-keys.env (git-ignored; shown only once)');
await owner.end();
