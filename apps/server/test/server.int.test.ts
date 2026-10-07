import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, sensorEvent, startBackend, startDatabase, waitFor, type Backend, type Db } from './stack.js';

/**
 * Integration tests on a real PostgreSQL (Testcontainers): API status codes and authorization (plan §12.1, §14.4),
 * database guarantees (§11) and restart recovery (§9). Run with `npm run test:integration`.
 */
let db: Db;
let b: Backend;
let operator: string;
let viewer: string;

const status = async () => (await b.app.inject({ method: 'GET', url: '/api/junctions/A/status', headers: { cookie: operator } })).json();
const command = (cookie: string, payload: Record<string, unknown>, headers: Record<string, string> = { 'x-ftms-request': '1' }) =>
  b.app.inject({ method: 'POST', url: '/api/junctions/A/commands', headers: { cookie, ...headers }, payload });
const sensor = (key: string, payload: Record<string, unknown>) =>
  b.app.inject({ method: 'POST', url: '/api/sensor-events', headers: { authorization: `Bearer ${key}` }, payload });

beforeAll(async () => {
  db = await startDatabase();
  b = await startBackend(db);
  operator = await login(b, 'operator');
  viewer = await login(b, 'viewer');
  await waitFor(status, (s) => s.interval.kind === 'GREEN');
}, 120_000);

afterAll(async () => {
  await b?.stop();
  await db?.owner.end();
  await db?.container.stop();
});

describe('authentication and authorization', () => {
  it('rejects unauthenticated reads with 401 problem details', async () => {
    const res = await b.app.inject({ method: 'GET', url: '/api/junctions/A/status' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
  });

  it('forbids a viewer from sending commands', async () => {
    expect((await command(viewer, { command: 'ALL_RED_HOLD', reason: 'x' })).statusCode).toBe(403);
  });

  it('requires the CSRF header on state-changing operator requests', async () => {
    const res = await command(operator, { command: 'ALL_RED_HOLD', reason: 'x' }, {});
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('CSRF_CHECK_FAILED');
  });

  it('rejects a wrong password and an unknown device key', async () => {
    expect((await b.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'operator', password: 'wrong-password-000' } })).statusCode).toBe(401);
    expect((await sensor('ftms_bogus', sensorEvent('NORTH', 'VEHICLE_ARRIVED', 'X-1', 'TRUCK'))).statusCode).toBe(401);
  });

  it('enforces device binding: a sensor may only report its own lane', async () => {
    const res = await sensor(db.keys.SOUTH!, sensorEvent('NORTH', 'VEHICLE_ARRIVED', 'X-2', 'TRUCK'));
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('DEVICE_NOT_BOUND');
  });

  it('a controller key cannot post sensor events', async () => {
    expect((await sensor(db.keys.controller!, sensorEvent('NORTH', 'VEHICLE_ARRIVED', 'X-3', 'TRUCK'))).statusCode).toBe(403);
  });

  it('returns 404 for an unknown junction in the URL', async () => {
    expect((await b.app.inject({ method: 'GET', url: '/api/junctions/ZZ/status', headers: { cookie: viewer } })).statusCode).toBe(404);
  });
});

describe('sensor events', () => {
  it('records an event once: 201, identical retry 200, reused id with a different payload 409', async () => {
    const before = (await status()).queues.EAST;
    const ev = sensorEvent('EAST', 'VEHICLE_ARRIVED', 'DUP-1', 'FORKLIFT');
    expect((await sensor(db.keys.EAST!, ev)).statusCode).toBe(201);
    const again = await sensor(db.keys.EAST!, ev);
    expect(again.statusCode).toBe(200);
    expect(again.json().duplicate).toBe(true);
    expect((await sensor(db.keys.EAST!, { ...ev, vehicle_type: 'TRUCK' })).statusCode).toBe(409);
    expect((await status()).queues.EAST).toBe(before + 1);
  });

  it('a clearance never makes a queue negative', async () => {
    const before = (await status()).queues.WEST;
    await sensor(db.keys.WEST!, sensorEvent('WEST', 'VEHICLE_CLEARED', 'NEVER-ARRIVED'));
    expect((await status()).queues.WEST).toBe(before);
  });

  it('rejects an invalid body with 422 and field errors, and a far-future timestamp with 422', async () => {
    const bad = await sensor(db.keys.NORTH!, { junction_id: 'A', direction: 'NORTH' });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().errors.length).toBeGreaterThan(0);
    const future = await sensor(db.keys.NORTH!, sensorEvent('NORTH', 'VEHICLE_ARRIVED', 'F-1', 'TRUCK', { timestamp: new Date(Date.now() + 3_600_000).toISOString() }));
    expect(future.statusCode).toBe(422);
  });

  it('answers an ACK for an unknown command with 422 and a security audit entry', async () => {
    const res = await b.app.inject({ method: 'POST', url: '/api/controller-events', headers: { authorization: `Bearer ${db.keys.controller}` }, payload: { type: 'ACK', command_id: 'cmd-nope', junction_id: 'A', status: 'ACK' } });
    expect(res.statusCode).toBe(422);
    const { rows } = await db.owner.query("SELECT 1 FROM audit_log WHERE event_type = 'UNKNOWN_COMMAND_ACK' AND correlation_id = 'cmd-nope'");
    expect(rows).toHaveLength(1);
  });
});

describe('operator commands', () => {
  it('rejects a stale expected_version with 409', async () => {
    const s = await status();
    const res = await command(operator, { command: 'ALL_RED_HOLD', reason: 'x', expected_version: s.version - 1 });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('STALE_VERSION');
  });

  it('rejects unknown fields (strict schema)', async () => {
    expect((await command(operator, { command: 'ALL_RED_HOLD', reason: 'x', role: 'ADMIN' })).statusCode).toBe(422);
  });

  it('refuses manual control while an emergency is active, then returns to automatic after it clears', async () => {
    const s = await status();
    const dir = s.phase === 'NORTH_SOUTH' ? 'EAST' : 'NORTH';
    expect((await sensor(db.keys[dir]!, sensorEvent(dir, 'VEHICLE_ARRIVED', 'EV-1', 'EMERGENCY'))).statusCode).toBe(201);
    const manual = await command(operator, { command: 'MANUAL_GREEN_REQUEST', direction: 'WEST', reason: 'x' });
    expect(manual.statusCode).toBe(409);
    expect(manual.json().code).toBe('EMERGENCY_ACTIVE');
    const green = await waitFor(status, (x) => x.interval.kind === 'GREEN' && x.actual_signals[dir] === 'GREEN', 20_000);
    expect(green.mode).toBe('EMERGENCY');
    await sensor(db.keys[dir]!, sensorEvent(dir, 'VEHICLE_CLEARED', 'EV-1'));
    expect((await status()).emergencies).toHaveLength(0);
  }, 30_000);

  it('replays an Idempotency-Key instead of executing twice', async () => {
    const headers = { 'x-ftms-request': '1', 'idempotency-key': `k-${Date.now()}` };
    const first = await command(operator, { command: 'ALL_RED_HOLD', reason: 'idem' }, headers);
    expect(first.statusCode).toBe(202);
    const second = await command(operator, { command: 'ALL_RED_HOLD', reason: 'idem' }, headers);
    expect(second.statusCode).toBe(202);
    const { rows } = await db.owner.query("SELECT count(*)::int AS n FROM operator_requests WHERE idempotency_key = $1", [headers['idempotency-key']]);
    expect(rows[0].n).toBe(1);
    expect((await command(operator, { command: 'RELEASE_HOLD', reason: 'idem' })).statusCode).toBe(202);
  });
});

describe('database guarantees', () => {
  it('the app role cannot UPDATE or DELETE audit_log', async () => {
    await expect(b.pool.query("UPDATE audit_log SET details = '{}' WHERE chain_seq = 1")).rejects.toThrow(/permission denied/);
    await expect(b.pool.query('DELETE FROM audit_log')).rejects.toThrow(/permission denied/);
  });

  it('allows at most one PENDING command per junction', async () => {
    const insert = (id: string, seq: number) => db.owner.query(
      `INSERT INTO controller_commands (command_id, junction_id, seq, epoch, kind, step, cause, status, issued_at)
       VALUES ($1, 'A', $2, 0, 'SAFE_STOP', 'TEST', 'TEST', 'PENDING', now())`, [id, seq]);
    const { rows } = await db.owner.query("SELECT count(*)::int AS n FROM controller_commands WHERE junction_id = 'A' AND status = 'PENDING'");
    if (rows[0].n === 0) await insert('t-pending-1', 10_000_001);
    await expect(insert('t-pending-2', 10_000_002)).rejects.toThrow(/one_pending_command_per_junction/);
    await db.owner.query("DELETE FROM controller_commands WHERE command_id LIKE 't-pending-%'");
  });

  it('audit:verify passes on a real chain and detects a tampered row', async () => {
    expect((await b.store.verifyChain('A')).brokenAt).toBeNull();
    for (let i = 0; i < 3; i++) await b.store.audit('TAMPER', null, [{ type: 'SYSTEM_STARTED', severity: 'INFO', details: { i } }], 'SYSTEM');
    expect((await b.store.verifyChain('TAMPER')).brokenAt).toBeNull();
    await db.owner.query(`UPDATE audit_log SET details = '{"i": 99}' WHERE chain_id = 'TAMPER' AND chain_seq = 2`);
    expect((await b.store.verifyChain('TAMPER')).brokenAt).toBe(2);
  });
});

describe('admin, history, docs and live updates', () => {
  it('lets an ADMIN create users (201, then 409) and forbids operators', async () => {
    const admin = await login(b, 'admin');
    const user = { username: 'shift.lead', password: 'shift-lead-password-1', role: 'OPERATOR' };
    const post = (cookie: string, payload: object) => b.app.inject({ method: 'POST', url: '/api/admin/users', headers: { cookie, 'x-ftms-request': '1' }, payload });
    expect((await post(operator, user)).statusCode).toBe(403);
    expect((await post(admin, user)).statusCode).toBe(201);
    expect((await post(admin, user)).statusCode).toBe(409);
    expect((await post(admin, { ...user, username: 'x2', password: 'short' })).statusCode).toBe(422);
    const res = await b.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: user.username, password: user.password } });
    expect(res.statusCode).toBe(204);
  });

  it('issues and revokes device keys; a revoked key is refused', async () => {
    const admin = await login(b, 'admin');
    const h = { cookie: admin, 'x-ftms-request': '1' };
    expect((await b.app.inject({ method: 'POST', url: '/api/admin/devices', headers: h, payload: { device_id: 'sensor-A-UP', kind: 'SENSOR', junction_id: 'A', approach: 'UP' } })).statusCode).toBe(422);
    const created = await b.app.inject({ method: 'POST', url: '/api/admin/devices', headers: h, payload: { device_id: 'sensor-A-NORTH-2', kind: 'SENSOR', junction_id: 'A', approach: 'NORTH' } });
    expect(created.statusCode).toBe(201);
    const key = created.json().key as string;
    expect((await sensor(key, sensorEvent('NORTH', 'VEHICLE_ARRIVED', 'K-1', 'TRUCK'))).statusCode).toBe(201);
    expect((await b.app.inject({ method: 'DELETE', url: '/api/admin/devices/sensor-A-NORTH-2', headers: h })).statusCode).toBe(204);
    expect((await sensor(key, sensorEvent('NORTH', 'VEHICLE_ARRIVED', 'K-2', 'TRUCK'))).statusCode).toBe(401);
  });

  it('filters history by time and validates the query', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const res = await b.app.inject({ method: 'GET', url: `/api/junctions/A/history?from=${encodeURIComponent(future)}`, headers: { cookie: viewer } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    expect((await b.app.inject({ method: 'GET', url: '/api/junctions/A/history?limit=1000', headers: { cookie: viewer } })).statusCode).toBe(422);
  });

  it('serves the OpenAPI document', async () => {
    const res = await b.app.inject({ method: 'GET', url: '/docs/json' });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json().paths)).toContain('/api/junctions/{id}/commands');
  });

  it('streams status and audit over SSE and replays missed audit entries after Last-Event-ID', async () => {
    const address = await b.app.listen({ port: 0, host: '127.0.0.1' });
    const read = async (headers: Record<string, string>, until: (text: string) => boolean) => {
      const ctrl = new AbortController();
      const res = await fetch(`${address}/api/stream?junctions=A`, { headers: { cookie: viewer, ...headers }, signal: ctrl.signal });
      const reader = res.body!.getReader();
      let text = '';
      const deadline = Date.now() + 8000;
      while (!until(text) && Date.now() < deadline) {
        const chunk = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), 500))]);
        if (chunk && !chunk.done) text += new TextDecoder().decode(chunk.value);
      }
      ctrl.abort();
      return text;
    };
    const live = read({}, (t) => /event: audit/.test(t));
    await new Promise((r) => setTimeout(r, 300));
    await sensor(db.keys.SOUTH!, sensorEvent('SOUTH', 'VEHICLE_ARRIVED', 'SSE-1', 'FORKLIFT'));
    const first = await live;
    expect(first).toContain('event: status');
    const id = /id: (A:\d+)/.exec(first)![1]!;

    // Changes made while disconnected are replayed from the audit log.
    await sensor(db.keys.SOUTH!, sensorEvent('SOUTH', 'VEHICLE_ARRIVED', 'SSE-2', 'FORKLIFT'));
    const replay = await read({ 'last-event-id': id }, (t) => t.includes('SSE-2'));
    expect(replay).toContain('SSE-2');
    expect(replay).not.toContain('"vehicleId":"SSE-1"');
  });
});

describe('restart recovery', () => {
  it('a restart with a command pending abandons it, raises the epoch and restores a known state through SAFE_STOP', async () => {
    await waitFor(status, (s) => s.interval.kind === 'GREEN' && !s.pending_command);
    const epochBefore = b.runtime.actor('A').snapshot.epoch;
    b.controller.autoAck = false; // the next command stays pending
    expect((await command(operator, { command: 'ALL_RED_HOLD', reason: 'restart test' })).statusCode).toBe(202);
    const pending = (await waitFor(status, (s) => s.pending_command !== null)).pending_command;
    await b.stop();

    b = await startBackend(db, { model: b.model });
    operator = await login(b, 'operator');
    const first = b.controller.sent[0]!;
    expect(first.type).toBe('SAFE_STOP');
    expect(first.epoch).toBeGreaterThan(epochBefore);

    const { rows } = await db.owner.query('SELECT status FROM controller_commands WHERE command_id = $1', [pending.command_id]);
    expect(rows[0].status).toBe('ABANDONED');
    const types = (await db.owner.query(
      "SELECT event_type FROM audit_log WHERE chain_id = 'A' AND event_type IN ('RECOVERY_STARTED','COMMAND_ABANDONED','RECOVERY_COMPLETED') ORDER BY chain_seq DESC LIMIT 3",
    )).rows.map((r) => r.event_type);
    expect(types).toContain('RECOVERY_STARTED');
    expect(types).toContain('COMMAND_ABANDONED');

    // The hold survives the restart; after SAFE_STOP is confirmed the junction is in a known all-red state.
    const s = await waitFor(status, (x) => x.actual_known === true, 20_000);
    expect(Object.values(s.actual_signals).every((a) => a === 'RED')).toBe(true);
    expect((await command(operator, { command: 'RELEASE_HOLD', reason: 'done' })).statusCode).toBe(202);
    await waitFor(status, (x) => x.interval.kind === 'GREEN', 20_000);
  }, 60_000);

  it('simulation routes do not exist when SIMULATION_MODE is off', async () => {
    await b.stop();
    b = await startBackend(db, { simulationMode: false, model: b.model });
    operator = await login(b, 'operator');
    const res = await b.app.inject({ method: 'POST', url: '/api/sim/sensor-events', headers: { cookie: operator, 'x-ftms-request': '1' }, payload: {} });
    expect(res.statusCode).toBe(404);
  }, 30_000);
});
