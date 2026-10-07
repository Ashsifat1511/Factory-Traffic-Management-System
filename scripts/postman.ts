/**
 * Generates docs/ftms.postman_collection.json and docs/ftms.postman_environment.json (plan §12.5, M7.2).
 * Usage: npx tsx scripts/postman.ts
 * One folder per spec §15 scenario. Requests use {{$isoTimestamp}}, {{$guid}} and a per-direction sequence counter so timestamps are current (RI-38).
 * Postman keeps the session cookie from "Login" in its cookie jar; device requests use the keys from .sim-keys.env.
 */
import { mkdirSync, writeFileSync } from 'node:fs';

type Body = Record<string, unknown>;
interface Item { name: string; request: unknown; event?: unknown[] }

// sequence_no and expected_version are numbers: write their Postman variables unquoted in the raw body.
const json = (b: Body) => ({
  mode: 'raw', options: { raw: { language: 'json' } },
  raw: JSON.stringify(b, null, 2).replace(/"\{\{(seq|version|dupSeq)\}\}"/g, '{{$1}}'),
});
const url = (path: string) => ({ raw: `{{baseUrl}}${path}`, host: ['{{baseUrl}}'], path: path.split('?')[0]!.split('/').filter(Boolean) });
const test = (lines: string[]) => [{ listen: 'test', script: { type: 'text/javascript', exec: lines } }];
const expect = (code: number) => test([`pm.test('status ${code}', () => pm.response.to.have.status(${code}));`]);

const op = (name: string, method: string, path: string, body?: Body, code?: number): Item => ({
  name,
  request: {
    method, url: url(path),
    header: [{ key: 'x-ftms-request', value: '1' }, ...(body ? [{ key: 'Content-Type', value: 'application/json' }] : [])],
    ...(body ? { body: json(body) } : {}),
  },
  ...(code ? { event: expect(code) } : {}),
});
const device = (name: string, keyVar: string, path: string, body: Body, code?: number): Item => ({
  name,
  request: {
    method: 'POST', url: url(path),
    header: [{ key: 'Authorization', value: `Bearer {{${keyVar}}}` }, { key: 'Content-Type', value: 'application/json' }],
    body: json(body),
  },
  ...(code ? { event: expect(code) } : {}),
});
const sensor = (direction: string, event_type: string, vehicle_id: string, vehicle_type?: string, extra: Body = {}): Body => ({
  event_id: '{{$guid}}', junction_id: 'A', direction, event_type, vehicle_id,
  ...(vehicle_type ? { vehicle_type } : {}), sequence_no: '{{seq}}', timestamp: '{{$isoTimestamp}}', ...extra,
});
const status = op('Status', 'GET', '/api/junctions/A/status', undefined, 200);
const command = (name: string, b: Body, code = 202) => op(name, 'POST', '/api/junctions/A/commands', b, code);
const sim = (name: string, b: Body) => op(name, 'PUT', '/api/sim/controllers/A', b, 200);
const folder = (name: string, description: string, item: Item[]) => ({ name, description, item });


const collection = {
  info: {
    name: 'FTMS – Factory Traffic Management System',
    description: 'One folder per spec §15 scenario. Run "00 Setup" first. Requires SIMULATION_MODE=true, the seeded users and the device keys from .sim-keys.env in the environment.',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  item: [
    folder('00 Setup', 'Log in as operator (session cookie kept by Postman) and reset the simulator.', [
      op('Login (operator)', 'POST', '/api/auth/login', { username: '{{operatorUser}}', password: '{{operatorPassword}}' }, 204),
      op('Me', 'GET', '/api/auth/me', undefined, 200),
      sim('Reset simulator faults', { latency_ms: 200, faults: { dropAcks: false, dropNextAck: false, nackNext: false, wrongStateNext: false, offline: false, unsafeHeartbeat: false } }),
      status,
    ]),
    folder('01 Normal traffic', 'Vehicles from several directions; the scheduler picks a phase. Wait ~20 s, then check Status.', [
      device('NORTH arrives (sensor key)', 'sensorKeyNorth', '/api/sensor-events', sensor('NORTH', 'VEHICLE_ARRIVED', 'N-1', 'EMPLOYEE_VEHICLE'), 201),
      device('EAST arrives (sensor key)', 'sensorKeyEast', '/api/sensor-events', sensor('EAST', 'VEHICLE_ARRIVED', 'E-1', 'FORKLIFT'), 201),
      status,
    ]),
    folder('02 Priority traffic', 'A TRUCK outweighs employee vehicles. Check PHASE_DECISION in history after the next block boundary.', [
      op('Two employee vehicles NORTH', 'POST', '/api/sim/sensor-events', { junction_id: 'A', direction: 'NORTH', event_type: 'VEHICLE_ARRIVED', vehicle_id: 'EMP-2', vehicle_type: 'EMPLOYEE_VEHICLE' }, 201),
      op('Truck EAST', 'POST', '/api/sim/sensor-events', { junction_id: 'A', direction: 'EAST', event_type: 'VEHICLE_ARRIVED', vehicle_id: 'TRK-2', vehicle_type: 'TRUCK' }, 201),
      op('Last phase decision', 'GET', '/api/junctions/A/history?type=PHASE_DECISION&limit=1', undefined, 200),
    ]),
    folder('03 Emergency preemption', 'EMERGENCY vehicle: the current green goes YELLOW → ALL_RED → emergency green. Poll Status every 2 s.', [
      op('Emergency arrives WEST', 'POST', '/api/sim/sensor-events', { junction_id: 'A', direction: 'WEST', event_type: 'VEHICLE_ARRIVED', vehicle_id: 'EV-3', vehicle_type: 'EMERGENCY' }, 201),
      status,
      op('Emergency cleared WEST', 'POST', '/api/sim/sensor-events', { junction_id: 'A', direction: 'WEST', event_type: 'VEHICLE_CLEARED', vehicle_id: 'EV-3' }, 201),
    ]),
    folder('04 Manual override', 'Manual green, a stale expected_version (409), and return to automatic.', [
      { ...status, event: test([
        "pm.test('status 200', () => pm.response.to.have.status(200));",
        "pm.collectionVariables.set('version', pm.response.json().version);",
      ]) },
      command('Manual green WEST', { command: 'MANUAL_GREEN_REQUEST', direction: 'WEST', reason: 'loading bay', expected_version: '{{version}}' }),
      command('Same request, stale version (409)', { command: 'MANUAL_GREEN_REQUEST', direction: 'WEST', reason: 'loading bay', expected_version: '{{version}}' }, 409),
      command('Extend manual lease', { command: 'EXTEND_MANUAL' }),
      command('Return to automatic', { command: 'RETURN_TO_AUTOMATIC', reason: 'done' }),
    ]),
    folder('05 Duplicate event', 'Send the identical event twice: 201 then 200 duplicate. The third reuses the id with a different payload: 409.', [
      { name: 'Prepare a fixed event id', request: { method: 'GET', url: url('/api/health/live') }, event: [{ listen: 'prerequest', script: { type: 'text/javascript', exec: [
        "pm.collectionVariables.set('dupId', 'dup-' + Date.now());",
        "pm.collectionVariables.set('dupSeq', Date.now());",
        "pm.collectionVariables.set('dupTs', new Date().toISOString());",
      ] } }] },
      device('First delivery (201)', 'sensorKeySouth', '/api/sensor-events', { event_id: '{{dupId}}', junction_id: 'A', direction: 'SOUTH', event_type: 'VEHICLE_ARRIVED', vehicle_id: 'D-5', vehicle_type: 'FORKLIFT', sequence_no: '{{dupSeq}}', timestamp: '{{dupTs}}' }, 201),
      device('Same event again (200 duplicate)', 'sensorKeySouth', '/api/sensor-events', { event_id: '{{dupId}}', junction_id: 'A', direction: 'SOUTH', event_type: 'VEHICLE_ARRIVED', vehicle_id: 'D-5', vehicle_type: 'FORKLIFT', sequence_no: '{{dupSeq}}', timestamp: '{{dupTs}}' }, 200),
      device('Same id, different payload (409)', 'sensorKeySouth', '/api/sensor-events', { event_id: '{{dupId}}', junction_id: 'A', direction: 'SOUTH', event_type: 'VEHICLE_ARRIVED', vehicle_id: 'D-5', vehicle_type: 'TRUCK', sequence_no: '{{dupSeq}}', timestamp: '{{dupTs}}' }, 409),
      device('Sensor posting for another lane (403)', 'sensorKeySouth', '/api/sensor-events', sensor('NORTH', 'VEHICLE_ARRIVED', 'X-5', 'TRUCK'), 403),
    ]),
    folder('06 Vehicle clearance', 'Arrival then clearance reduces the queue; a second clear never goes below zero.', [
      device('Arrive WEST', 'sensorKeyWest', '/api/sensor-events', sensor('WEST', 'VEHICLE_ARRIVED', 'VH-6', 'TRUCK'), 201),
      device('Clear WEST', 'sensorKeyWest', '/api/sensor-events', sensor('WEST', 'VEHICLE_CLEARED', 'VH-6'), 201),
      device('Clear again (no-op)', 'sensorKeyWest', '/api/sensor-events', sensor('WEST', 'VEHICLE_CLEARED', 'VH-6'), 201),
    ]),
    folder('07 Controller failure', 'Drop ACKs: retries then FAILED + SAFE_STOP. Then offline (heartbeat watchdog), then reconnect.', [
      sim('Drop all ACKs', { faults: { dropAcks: true } }),
      command('All-red hold (needs ACKs)', { command: 'ALL_RED_HOLD', reason: 'controller test' }),
      status,
      sim('Restore ACKs, go offline', { faults: { dropAcks: false, offline: true } }),
      sim('Back online', { faults: { offline: false } }),
      command('Resume after fault', { command: 'RESUME_AFTER_FAULT', reason: 'controller checked' }),
      command('Release hold', { command: 'RELEASE_HOLD', reason: 'done' }),
      op('Unknown command ACK (422)', 'POST', '/api/sim/controller-events', { type: 'ACK', command_id: 'cmd-does-not-exist', junction_id: 'A', status: 'ACK' }, 422),
    ]),
    folder('08 Restart', 'Stop the server (Ctrl+C) and start it again, then send these. Expect UNKNOWN → SAFE_STOP → normal operation.', [
      op('Readiness', 'GET', '/api/health/ready', undefined, 200),
      status,
      op('Last RECOVERY_STARTED', 'GET', '/api/junctions/A/history?type=RECOVERY_STARTED&limit=1', undefined, 200),
    ]),
    folder('09 Concurrent events', 'Use the Collection Runner with delay 0 on this folder: the actor serialises them; the emergency wins and the manual request gets 409.', [
      op('Truck NORTH', 'POST', '/api/sim/sensor-events', { junction_id: 'A', direction: 'NORTH', event_type: 'VEHICLE_ARRIVED', vehicle_id: 'TR-9', vehicle_type: 'TRUCK' }, 201),
      op('Emergency EAST', 'POST', '/api/sim/sensor-events', { junction_id: 'A', direction: 'EAST', event_type: 'VEHICLE_ARRIVED', vehicle_id: 'EV-9', vehicle_type: 'EMERGENCY' }, 201),
      command('Manual green WEST (409 emergency active)', { command: 'MANUAL_GREEN_REQUEST', direction: 'WEST', reason: 'conflict' }, 409),
      op('Emergency cleared EAST', 'POST', '/api/sim/sensor-events', { junction_id: 'A', direction: 'EAST', event_type: 'VEHICLE_CLEARED', vehicle_id: 'EV-9' }, 201),
    ]),
  ],
  // sequence_no is per sensor stream (plan §5.4): keep one counter per direction so no gaps are reported.
  event: [{ listen: 'prerequest', script: { type: 'text/javascript', exec: [
    "const raw = pm.request.body && pm.request.body.raw;",
    "const m = raw && raw.match(/direction.: .([A-Z_]+)/);",
    "if (m) { const k = 'seq_' + m[1]; const v = (Number(pm.collectionVariables.get(k)) || Date.now()) + 1; pm.collectionVariables.set(k, v); pm.collectionVariables.set('seq', v); }",
  ] } }],
  variable: [{ key: 'version', value: '0' }, { key: 'seq', value: '1' }],
};

const text = JSON.stringify(collection, null, 2);

const env = {
  name: 'FTMS local',
  values: [
    ['baseUrl', 'http://localhost:8080'],
    ['operatorUser', 'operator'],
    ['operatorPassword', 'operator-password-123'],
    ['sensorKeyNorth', '<SENSOR_KEY_A_NORTH from .sim-keys.env>'],
    ['sensorKeySouth', '<SENSOR_KEY_A_SOUTH from .sim-keys.env>'],
    ['sensorKeyEast', '<SENSOR_KEY_A_EAST from .sim-keys.env>'],
    ['sensorKeyWest', '<SENSOR_KEY_A_WEST from .sim-keys.env>'],
    ['controllerKey', '<CONTROLLER_KEY_A from .sim-keys.env>'],
  ].map(([key, value]) => ({ key, value, enabled: true, ...(key!.includes('Key') || key!.includes('Password') ? { type: 'secret' } : {}) })),
};

mkdirSync(new URL('../docs/', import.meta.url), { recursive: true });
writeFileSync(new URL('../docs/ftms.postman_collection.json', import.meta.url), `${text}\n`);
writeFileSync(new URL('../docs/ftms.postman_environment.json', import.meta.url), `${JSON.stringify(env, null, 2)}\n`);
console.log('wrote docs/ftms.postman_collection.json and docs/ftms.postman_environment.json');
