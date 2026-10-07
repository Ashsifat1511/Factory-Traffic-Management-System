/**
 * Demonstrates the nine spec §15 scenarios against the running stack (server + controller simulator).
 * Usage: npx tsx scripts/scenarios.ts [1..9 | all]
 * Requires SIMULATION_MODE=true and the seeded `operator` user.
 */
const B = process.env.BACKEND_URL ?? 'http://localhost:8080';
const USER = process.env.SCENARIO_USER ?? 'operator';
const PASS = process.env.SEED_OPERATOR_PASSWORD ?? 'operator-password-123';
let cookie = '';

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(B + path, {
    method,
    headers: { cookie, 'x-ftms-request': '1', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0]!;
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const status = async () => (await call('GET', '/api/junctions/A/status')).body;
const show = (label: string, s: { mode: string; health: string; phase: string; actual_signals: Record<string, string>; queues: Record<string, number> }) =>
  console.log(`  ${label}: mode=${s.mode} health=${s.health} phase=${s.phase} actual=${JSON.stringify(s.actual_signals)} queues=${JSON.stringify(s.queues)}`);
const sensor = (direction: string, event_type: string, vehicle_id: string, vehicle_type?: string, extra: Record<string, unknown> = {}) =>
  call('POST', '/api/sim/sensor-events', { junction_id: 'A', direction, event_type, vehicle_id, ...(vehicle_type ? { vehicle_type } : {}), ...extra });
const command = (command: string, extra: Record<string, unknown> = {}) => call('POST', '/api/junctions/A/commands', { command, reason: 'scenario', ...extra });
const sim = (patch: unknown) => call('PUT', '/api/sim/controllers/A', patch);
const otherThan = (phase: string) => (phase === 'NORTH_SOUTH' ? 'EAST' : 'NORTH');
const id = () => Math.random().toString(36).slice(2, 7);

async function reset() {
  await sim({ latency_ms: 200, faults: { dropAcks: false, dropNextAck: false, nackNext: false, wrongStateNext: false, offline: false, unsafeHeartbeat: false } });
  await command('RETURN_TO_AUTOMATIC');
  await command('RELEASE_HOLD');
  await command('EMERGENCY_CANCEL');
  if ((await status()).allowed_commands.includes('RESUME_AFTER_FAULT')) await command('RESUME_AFTER_FAULT');
  for (let i = 0; i < 30 && (await status()).interval.kind !== 'GREEN'; i++) await sleep(1000);
}

const scenarios: Record<string, () => Promise<void>> = {
  async 1() {
    console.log('1. Normal traffic: vehicles from several directions; the scheduler picks a phase.');
    const s = await status();
    const waiting = otherThan(s.phase);
    for (const d of [waiting, waiting]) console.log(`  arrive ${d}:`, (await sensor(d, 'VEHICLE_ARRIVED', `N-${id()}`, 'EMPLOYEE_VEHICLE')).body.outcome);
    show('now', await status());
    console.log('  waiting ~22 s: the green phase has no demand, so after min green it gaps out through YELLOW and ALL_RED...');
    await sleep(22_000);
    show('after', await status());
  },
  async 2() {
    console.log('2. Priority traffic: a TRUCK outweighs ordinary employee vehicles.');
    const s = await status();
    const own = s.phase === 'NORTH_SOUTH' ? 'NORTH' : 'EAST';
    const other = otherThan(s.phase);
    for (let i = 0; i < 2; i++) await sensor(own, 'VEHICLE_ARRIVED', `E-${id()}`, 'EMPLOYEE_VEHICLE');
    console.log(`  truck at ${other}:`, (await sensor(other, 'VEHICLE_ARRIVED', `T-${id()}`, 'TRUCK')).body.outcome);
    console.log('  the next 30 s block boundary compares scores (see PHASE_DECISION in history).');
    await sleep(31_000);
    show('after', await status());
    const hist = (await call('GET', '/api/junctions/A/history?type=PHASE_DECISION&limit=1')).body;
    console.log('  last decision:', JSON.stringify(hist[0]?.details));
  },
  async 3() {
    console.log('3. Emergency preemption: never jumps straight to the conflicting green.');
    const s = await status();
    const dir = otherThan(s.phase);
    const ev = `EV-${id()}`;
    console.log(`  emergency at ${dir}:`, (await sensor(dir, 'VEHICLE_ARRIVED', ev, 'EMERGENCY')).body.outcome);
    for (let i = 0; i < 6; i++) { show(`t+${i * 2}s`, await status()); await sleep(2000); }
    console.log('  clear:', (await sensor(dir, 'VEHICLE_CLEARED', ev)).body.outcome);
    show('after', await status());
  },
  async 4() {
    console.log('4. Manual override and return to automatic.');
    const s = await status();
    const dir = s.phase === 'NORTH_SOUTH' ? 'WEST' : 'NORTH';
    console.log(`  manual green ${dir}:`, (await command('MANUAL_GREEN_REQUEST', { direction: dir, expected_version: s.version })).status);
    console.log('  same request with an outdated version:', (await command('MANUAL_GREEN_REQUEST', { direction: dir, expected_version: s.version })).body.code);
    await sleep(22_000);
    show('manual', await status());
    console.log('  return to automatic:', (await command('RETURN_TO_AUTOMATIC')).status);
    show('after', await status());
  },
  async 5() {
    console.log('5. Duplicate event: the same event twice changes the queue once.');
    const ev = { event_id: `dup-${id()}`, sequence_no: 900_000 + Math.floor(Math.random() * 1000), timestamp: new Date().toISOString() };
    const v = `D-${id()}`;
    console.log('  first:', JSON.stringify((await sensor('SOUTH', 'VEHICLE_ARRIVED', v, 'FORKLIFT', ev)).body));
    console.log('  again:', JSON.stringify((await sensor('SOUTH', 'VEHICLE_ARRIVED', v, 'FORKLIFT', ev)).body));
    const r = await sensor('SOUTH', 'VEHICLE_ARRIVED', v, 'TRUCK', ev);
    console.log('  same id, different payload:', r.status, r.body.code);
  },
  async 6() {
    console.log('6. Vehicle clearance (and out-of-order delivery).');
    const v = `VH-${id()}`;
    console.log('  arrive:', (await sensor('WEST', 'VEHICLE_ARRIVED', v, 'TRUCK')).body.queues);
    console.log('  clear :', (await sensor('WEST', 'VEHICLE_CLEARED', v)).body.queues);
    console.log('  clear again:', (await sensor('WEST', 'VEHICLE_CLEARED', v)).body.outcome, '(queue never below 0)');
    const w = `VH-${id()}`;
    console.log('  CLEARED seq 1502 first:', (await sensor('WEST', 'VEHICLE_CLEARED', w, undefined, { sequence_no: 5_001_502 })).body.outcome);
    console.log('  ARRIVED seq 1501 late :', (await sensor('WEST', 'VEHICLE_ARRIVED', w, 'TRUCK', { sequence_no: 5_001_501 })).body.outcome);
  },
  async 7() {
    console.log('7. Controller failure: missing ACKs, then offline, then recovery.');
    await sim({ faults: { dropAcks: true } });
    console.log('  hold all red (needs controller ACKs):', (await command('ALL_RED_HOLD')).status);
    await sleep(8000);
    show('no ACKs', await status());
    await sim({ faults: { dropAcks: false, offline: true } });
    console.log('  controller offline; waiting 17 s for the heartbeat watchdog...');
    await sleep(17_000);
    show('offline', await status());
    await sim({ faults: { offline: false } });
    await sleep(12_000);
    show('reconnected', await status());
    await command('RELEASE_HOLD');
  },
  async 8() {
    console.log('8. Restart: stop the server (Ctrl+C) and start it again, then run this scenario.');
    show('current', await status());
    const h = (await call('GET', '/api/junctions/A/history?type=RECOVERY_STARTED&limit=1')).body[0];
    console.log('  last recovery started at', h?.occurred_at, JSON.stringify(h?.details));
  },
  async 9() {
    console.log('9. Concurrent events within milliseconds.');
    await sim({ latency_ms: 12 });
    const s = await status();
    const [a, b] = s.phase === 'NORTH_SOUTH' ? ['NORTH', 'EAST'] : ['EAST', 'NORTH'];
    const ev = { event_id: `em-${id()}`, timestamp: new Date().toISOString(), sequence_no: 7_000_000 + Math.floor(Math.random() * 1000) };
    const v = `EV-${id()}`;
    const at = (ms: number, fn: () => Promise<{ status: number; body: { outcome?: string; code?: string } }>) => sleep(ms).then(fn);
    const results = await Promise.all([
      at(0, () => sensor(a, 'VEHICLE_ARRIVED', `TR-${id()}`, 'TRUCK')),
      at(4, () => sensor(b, 'VEHICLE_ARRIVED', v, 'EMERGENCY', ev)),
      at(8, () => command('MANUAL_GREEN_REQUEST', { direction: 'WEST' })),
      at(12, () => sensor(b, 'VEHICLE_ARRIVED', v, 'EMERGENCY', ev)),
    ]);
    results.forEach((r, i) => console.log(`  request ${i + 1}: ${r.status} ${r.body.outcome ?? r.body.code}`));
    await sleep(12_000);
    show('after', await status());
    await sensor(b, 'VEHICLE_CLEARED', v);
    await sim({ latency_ms: 200 });
  },
};

const which = process.argv[2] ?? 'all';
const login = await call('POST', '/api/auth/login', { username: USER, password: PASS });
if (login.status !== 204) { console.error('login failed', login.status); process.exit(1); }
for (const k of which === 'all' ? Object.keys(scenarios) : [which]) {
  await reset();
  await scenarios[k]!();
  console.log();
}
