/**
 * Background traffic generator (plan M7.3, optional): random arrivals on every approach, and clearances for vehicles
 * whose approach is green, through the simulation API. Ctrl+C to stop.
 * Usage: npm run traffic -- [arrivals per minute, default 20] [truck share 0..1, default 0.2]
 */
const B = process.env.BACKEND_URL ?? 'http://localhost:8080';
const perMinute = Number(process.argv[2] ?? 20);
const truckShare = Number(process.argv[3] ?? 0.2);
let cookie = '';

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(B + path, {
    method, headers: { cookie, 'x-ftms-request': '1', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0]!;
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const login = await call('POST', '/api/auth/login', { username: process.env.SCENARIO_USER ?? 'operator', password: process.env.SEED_OPERATOR_PASSWORD ?? 'operator-password-123' });
if (login.status !== 204) { console.error('login failed', login.status); process.exit(1); }

const directions = ['NORTH', 'SOUTH', 'EAST', 'WEST'];
const waiting: Record<string, string[]> = Object.fromEntries(directions.map((d) => [d, []]));
const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]!;
const type = () => (Math.random() < truckShare ? 'TRUCK' : pick(['EMPLOYEE_VEHICLE', 'EMPLOYEE_VEHICLE', 'FORKLIFT', 'MATERIAL_CARRIER']));
let n = 0;

setInterval(async () => {
  const d = pick(directions);
  const id = `TG-${Date.now().toString(36)}-${++n}`;
  const r = await call('POST', '/api/sim/sensor-events', { junction_id: 'A', direction: d, event_type: 'VEHICLE_ARRIVED', vehicle_id: id, vehicle_type: type() });
  if (r.status === 201) waiting[d]!.push(id);
  console.log(`${new Date().toISOString()} arrive ${d.padEnd(5)} ${id} → ${r.body?.outcome ?? r.body?.code}`);
}, 60_000 / perMinute);

// Every 2 s, one vehicle per green approach drives through.
setInterval(async () => {
  const s = (await call('GET', '/api/junctions/A/status')).body as { actual_signals: Record<string, string> };
  for (const d of directions) {
    if (s.actual_signals[d] !== 'GREEN' || !waiting[d]!.length) continue;
    const id = waiting[d]!.shift()!;
    await call('POST', '/api/sim/sensor-events', { junction_id: 'A', direction: d, event_type: 'VEHICLE_CLEARED', vehicle_id: id });
    console.log(`${new Date().toISOString()} clear  ${d.padEnd(5)} ${id}`);
  }
}, 2000);
