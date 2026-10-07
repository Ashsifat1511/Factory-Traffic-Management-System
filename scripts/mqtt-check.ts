/**
 * M6 security and transport checks against the running MQTT stack (plan §18 M6.6).
 * Usage: npx tsx scripts/mqtt-check.ts   (broker, server and simulator running with CONTROLLER_TRANSPORT=mqtt)
 *  1. A wrong password is refused.
 *  2. A sensor that publishes to a controller commands topic is denied by the ACL (the message never arrives).
 *  3. A sensor event on the sensor's own topic is processed by the backend.
 *  4. A payload whose direction does not match its topic is rejected (TOPIC_MISMATCH).
 *  5. An expired command is never executed: the controller answers NACK EXPIRED and its lights do not change.
 */
import { existsSync, readFileSync } from 'node:fs';
import mqtt, { type MqttClient } from 'mqtt';
import pg from 'pg';

const root = new URL('../', import.meta.url);
const envFile = (f: string): Record<string, string> => (existsSync(new URL(f, root))
  ? Object.fromEntries(readFileSync(new URL(f, root), 'utf8').split(/\r?\n/).map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l)).filter((m) => m).map((m) => [m![1]!, m![2]!]))
  : {});
const env = { ...envFile('.env'), ...envFile('.mqtt-creds.env'), ...process.env } as Record<string, string>;
const URL_ = env.MQTT_URL ?? 'mqtts://localhost:8883';
const ca = readFileSync(new URL(env.MQTT_CA_FILE ?? 'infra/mosquitto/certs/ca.crt', root));
const B = env.BACKEND_URL ?? 'http://localhost:8080';

const connect = (username: string, password: string) =>
  mqtt.connectAsync(URL_, { protocolVersion: 5, username, password, ca, clean: true, reconnectPeriod: 0, connectTimeout: 4000, clientId: `check-${username}-${process.pid}` });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name: string, ok: boolean, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) failures++; };

async function login() {
  const res = await fetch(`${B}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'operator', password: env.SEED_OPERATOR_PASSWORD ?? 'operator-password-123' }) });
  return res.headers.get('set-cookie')!.split(';')[0]!;
}
const status = async (cookie: string) => (await fetch(`${B}/api/junctions/A/status`, { headers: { cookie } })).json() as Promise<{ queues: Record<string, number>; actual_signals: Record<string, string> }>;

// 1
try { const c = await connect('sensor-A-NORTH', 'wrong-password'); await c.endAsync(); check('wrong password refused', false); }
catch (e) { check('wrong password refused', true, (e as Error).message); }

const sensor = await connect('sensor-A-NORTH', env.MQTT_PASSWORD_SENSOR_A_NORTH!);
const spy: MqttClient = await connect('ftms-backend', env.MQTT_PASSWORD_FTMS_BACKEND!);
const seen: { topic: string; body: Record<string, unknown> }[] = [];
spy.on('message', (topic, p) => { try { seen.push({ topic, body: JSON.parse(p.toString()) }); } catch { /* status strings */ } });
await spy.subscribeAsync(['ftms/v1/junctions/A/controller/commands', 'ftms/v1/junctions/A/controller/acks'], { qos: 1 });

// 2
const forgedId = `forged-${Date.now()}`;
await sensor.publishAsync('ftms/v1/junctions/A/controller/commands', JSON.stringify({ type: 'SAFE_STOP', command_id: forgedId }), { qos: 1 }).catch(() => undefined);
await sleep(1500);
check('sensor cannot publish to the commands topic (ACL)', !seen.some((m) => m.body.command_id === forgedId));

// 3 and 4
const cookie = await login();
const before = (await status(cookie)).queues.NORTH ?? 0;
const ev = (direction: string) => JSON.stringify({ event_id: `mq-${Date.now()}-${direction}`, junction_id: 'A', direction, event_type: 'VEHICLE_ARRIVED', vehicle_id: `MQ-${Date.now()}`, vehicle_type: 'FORKLIFT', sequence_no: Date.now(), timestamp: new Date().toISOString() });
await sensor.publishAsync('ftms/v1/junctions/A/sensors/NORTH/events', ev('NORTH'), { qos: 1 });
await sleep(800);
const after = (await status(cookie)).queues.NORTH ?? 0;
check('sensor event over MQTT is processed', after === before + 1 || after > before, `NORTH queue ${before} → ${after}`);

const mismatch = ev('SOUTH');
await sensor.publishAsync('ftms/v1/junctions/A/sensors/NORTH/events', mismatch, { qos: 1 });
await sleep(800);
const db = new pg.Client({ connectionString: env.DATABASE_OWNER_URL });
await db.connect();
const { rows } = await db.query("SELECT 1 FROM rejected_events WHERE channel = 'MQTT' AND reason_code = 'TOPIC_MISMATCH' AND payload::text LIKE $1", [`%${JSON.parse(mismatch).event_id}%`]);
await db.end();
check('payload/topic mismatch rejected', rows.length === 1);

// 5
const lights = (await status(cookie)).actual_signals;
const expiredId = `expired-${Date.now()}`;
await spy.publishAsync('ftms/v1/junctions/A/controller/commands', JSON.stringify({
  type: 'SET_ASPECTS', command_id: expiredId, junction_id: 'A', seq: 1, epoch: 2 ** 30,
  aspects: { NORTH: 'RED', SOUTH: 'RED', EAST: 'RED', WEST: 'RED' },
  issued_at: new Date(Date.now() - 10_000).toISOString(), expires_at: new Date(Date.now() - 5_000).toISOString(), attempt: 1,
}), { qos: 1 });
await sleep(1500);
const nack = seen.find((m) => m.topic.endsWith('/acks') && m.body.command_id === expiredId);
check('expired command is not executed', nack?.body.status === 'NACK' && nack.body.reason === 'EXPIRED' && JSON.stringify((await status(cookie)).actual_signals) === JSON.stringify(lights), `reply ${nack?.body.status} ${nack?.body.reason}`);

await sensor.endAsync();
await spy.endAsync();
console.log(failures ? `${failures} check(s) failed` : 'all MQTT checks passed');
process.exit(failures ? 1 : 0);
