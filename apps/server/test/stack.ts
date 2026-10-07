import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { configFromJson } from '@ftms/domain';
import { ControllerModel, type AckReply, type ControllerCommand } from '@ftms/sim-core';
import { buildApp } from '../src/adapters/http/app.js';
import { createPool, migrate, type Pool } from '../src/adapters/postgres/db.js';
import { Security } from '../src/adapters/postgres/security.js';
import { Store } from '../src/adapters/postgres/store.js';
import { Runtime, type ControllerGateway, type WireCommand } from '../src/application/runtime.js';

export const A_JSON = JSON.parse(readFileSync(new URL('../../../config/junctions/A.json', import.meta.url), 'utf8'));
const PEPPER = 'integration-test-pepper-0123456789';
export const PASSWORDS = { admin: 'admin-password-123', operator: 'operator-password-123', viewer: 'viewer-password-123' } as const;

/** One Postgres container per test file, with the same roles as docker compose (owner + restricted app role). */
export async function startDatabase() {
  const container = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('ftms').withUsername('ftms_owner').withPassword('owner-pw')
    .withEnvironment({ DB_APP_PASSWORD: 'app-pw' })
    .withCopyFilesToContainer([{ source: fileURLToPath(new URL('../../../infra/postgres/init/01-roles.sh', import.meta.url)), target: '/docker-entrypoint-initdb.d/01-roles.sh', mode: 0o755 }])
    .start();
  const url = (user: string, pw: string) => `postgres://${user}:${pw}@${container.getHost()}:${container.getPort()}/ftms`;
  const owner = createPool(url('ftms_owner', 'owner-pw'));
  await migrate(owner);
  const ownerStore = new Store(owner);
  await ownerStore.createJunction(configFromJson(A_JSON), 'test');
  const security = new Security(owner, PEPPER, ownerStore);
  for (const [name, role] of [['admin', 'ADMIN'], ['operator', 'OPERATOR'], ['viewer', 'VIEWER']] as const) {
    await security.createUser(name, PASSWORDS[name], role, role !== 'VIEWER');
  }
  const keys: Record<string, string> = { controller: await security.createDevice('ctrl-A', 'CONTROLLER', 'A', null) };
  for (const a of ['NORTH', 'SOUTH', 'EAST', 'WEST']) keys[a] = await security.createDevice(`sensor-A-${a}`, 'SENSOR', 'A', a);
  return { container, owner, keys, appUrl: url('ftms_app', 'app-pw') };
}

export type Db = Awaited<ReturnType<typeof startDatabase>>;

/**
 * A backend process (runtime + HTTP app) on top of the database. The controller is an in-process `sim-core`
 * model whose ACKs go back through `POST /api/controller-events`, like the real simulator.
 */
export async function startBackend(db: Db, opts: { simulationMode?: boolean; autoAck?: boolean; model?: ControllerModel } = {}) {
  const pool: Pool = createPool(db.appUrl);
  const store = new Store(pool);
  const security = new Security(pool, PEPPER, store);
  // Pass the previous backend's model to keep the physical lights across a backend restart.
  const model = opts.model ?? new ControllerModel('A', A_JSON.signal_groups.map((g: { id: string }) => g.id), A_JSON.conflicts, 3000, 1000, Date.now());
  const controller = { autoAck: opts.autoAck ?? true, sent: [] as WireCommand[] };
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  const post = (payload: object) => app?.inject({ method: 'POST', url: '/api/controller-events', headers: { authorization: `Bearer ${db.keys.controller}` }, payload }).catch(() => undefined);
  const reply = (ack: AckReply | null) => {
    if (!ack || !app || !controller.autoAck) return;
    void post({ ...ack, controller_ts: new Date(ack.controller_ts).toISOString() });
  };
  const gateway: ControllerGateway = {
    send(_j, cmd) {
      controller.sent.push(cmd);
      setTimeout(() => reply(model.handle({ ...cmd, aspects: cmd.aspects as ControllerCommand['aspects'], issued_at: Date.parse(cmd.issued_at), expires_at: Date.parse(cmd.expires_at) }, Date.now())), 20);
    },
  };
  const tick = setInterval(() => reply(model.tick(Date.now())), 100);
  const heartbeat = setInterval(() => {
    const hb = model.heartbeat(Date.now());
    if (hb && controller.autoAck) void post({ ...hb, controller_ts: new Date(hb.controller_ts).toISOString() });
  }, 1000);
  const runtime = new Runtime(store, gateway);
  app = await buildApp({ runtime, store, security, simulationMode: opts.simulationMode ?? true, dashboardOrigin: 'http://127.0.0.1:3000', cookieSecure: false });
  await runtime.start();
  const stop = async () => {
    clearInterval(tick);
    clearInterval(heartbeat);
    runtime.stop();
    await app!.close();
    await pool.end();
  };
  return { app, runtime, store, pool, model, controller, stop };
}

export type Backend = Awaited<ReturnType<typeof startBackend>>;

export async function login(b: Backend, user: keyof typeof PASSWORDS): Promise<string> {
  const res = await b.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: user, password: PASSWORDS[user] } });
  if (res.statusCode !== 204) throw new Error(`login ${user} failed: ${res.statusCode}`);
  return String(res.headers['set-cookie']).split(';')[0]!;
}

export async function waitFor<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > until) throw new Error(`waitFor timed out; last value ${JSON.stringify(v).slice(0, 400)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

let seq = 1;
export const sensorEvent = (direction: string, event_type: string, vehicle_id: string, vehicle_type?: string, extra: Record<string, unknown> = {}) => ({
  event_id: `it-${Date.now()}-${seq}`, junction_id: 'A', direction, event_type, vehicle_id,
  ...(vehicle_type ? { vehicle_type } : {}), sequence_no: seq++, timestamp: new Date().toISOString(), ...extra,
});
