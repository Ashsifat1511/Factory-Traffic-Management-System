import { existsSync, readFileSync } from 'node:fs';
import Fastify from 'fastify';
import { ControllerModel, type AckReply, type ControllerCommand } from '@ftms/sim-core';

function loadDotEnv(path: URL = new URL('../../../.env', import.meta.url)) {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split(String.fromCharCode(10))) {
    const line = raw.replace(String.fromCharCode(13), '');
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(#.*)?$/.exec(line);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!;
  }
}

/**
 * Controller simulator (plan §8.5). A separate process standing in for the junction controllers, so it keeps
 * its lights through a backend restart. REST transport: receives commands, posts ACKs and heartbeats.
 */
loadDotEnv();
loadDotEnv(new URL('../../../.sim-keys.env', import.meta.url));
const BACKEND = process.env.BACKEND_URL ?? 'http://localhost:8080';
const TOKEN = process.env.BACKEND_TO_SIM_TOKEN ?? '';
const PORT = Number(process.env.SIM_PORT ?? 8090);
const junctionIds = (process.env.SIM_JUNCTIONS ?? 'A').split(',');

interface Sim { model: ControllerModel; key: string; latencyMs: number; lastBackendContact: number; localFailsafe: boolean; log: string[] }
const sims = new Map<string, Sim>();

for (const j of junctionIds) {
  const raw = JSON.parse(readFileSync(new URL(`../../../config/junctions/${j}.json`, import.meta.url), 'utf8'));
  const groups = raw.signal_groups.map((g: { id: string }) => g.id);
  sims.set(j, {
    model: new ControllerModel(j, groups, raw.conflicts, 3000, 1000, Date.now()),
    key: process.env[`CONTROLLER_KEY_${j}`] ?? '', latencyMs: 200, lastBackendContact: Date.now(), localFailsafe: false, log: [],
  });
}

const note = (s: Sim, m: string) => { s.log.unshift(`${new Date().toISOString()} ${m}`); s.log.length = Math.min(s.log.length, 30); };

async function post(s: Sim, body: unknown) {
  try {
    const res = await fetch(`${BACKEND}/api/controller-events`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${s.key}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(2000),
    });
    if (res.ok) s.lastBackendContact = Date.now();
    else note(s, `backend answered ${res.status}`);
  } catch {
    note(s, 'backend unreachable');
  }
}

const sendAck = (s: Sim, ack: AckReply | null) => {
  if (!ack) return;
  note(s, `${ack.status} ${ack.command_id}${ack.reason ? ` (${ack.reason})` : ''}`);
  void post(s, { ...ack, controller_ts: new Date(ack.controller_ts).toISOString() });
};

const app = Fastify({ logger: false });

app.post<{ Body: ControllerCommand & { issued_at: string; expires_at: string } }>('/commands', async (req, reply) => {
  if (req.headers['x-backend-token'] !== TOKEN) return reply.status(401).send({ error: 'bad token' });
  const s = sims.get(req.body.junction_id);
  if (!s) return reply.status(404).send({ error: 'unknown junction' });
  s.lastBackendContact = Date.now();
  const cmd: ControllerCommand = { ...req.body, issued_at: Date.parse(req.body.issued_at), expires_at: Date.parse(req.body.expires_at) };
  note(s, `received ${cmd.type} ${cmd.command_id} seq ${cmd.seq} attempt ${cmd.attempt}`);
  setTimeout(() => sendAck(s, s.model.handle(cmd, Date.now())), s.latencyMs);
  return reply.status(202).send({ accepted: true });
});

app.get<{ Params: { id: string } }>('/junctions/:id', async (req, reply) => {
  if (req.headers['x-backend-token'] !== TOKEN) return reply.status(401).send({ error: 'bad token' });
  const s = sims.get(req.params.id);
  if (!s) return reply.status(404).send({ error: 'unknown junction' });
  return { junction_id: req.params.id, aspects: s.model.aspects, latency_ms: s.latencyMs, faults: s.model.faults, local_failsafe: s.localFailsafe, log: s.log };
});

app.put<{ Params: { id: string }; Body: { latency_ms?: number; faults?: Partial<ControllerModel['faults']>; device_status?: { device_type: string; direction?: string; status: string } } }>('/junctions/:id', async (req, reply) => {
  if (req.headers['x-backend-token'] !== TOKEN) return reply.status(401).send({ error: 'bad token' });
  const s = sims.get(req.params.id);
  if (!s) return reply.status(404).send({ error: 'unknown junction' });
  if (typeof req.body.latency_ms === 'number') s.latencyMs = Math.max(0, Math.min(5000, req.body.latency_ms));
  if (req.body.faults) Object.assign(s.model.faults, req.body.faults);
  if (req.body.device_status) {
    void post(s, { type: 'DEVICE_STATUS', event_id: `sim-status-${Date.now()}`, junction_id: req.params.id, timestamp: new Date().toISOString(), ...req.body.device_status });
  }
  note(s, `settings changed ${JSON.stringify(req.body)}`);
  return { junction_id: req.params.id, aspects: s.model.aspects, latency_ms: s.latencyMs, faults: s.model.faults };
});

// Local timers: SAFE_STOP clearance, heartbeats and the backend watchdog (rule C-6).
setInterval(() => {
  for (const s of sims.values()) {
    sendAck(s, s.model.tick(Date.now()));
    if (!s.localFailsafe && Date.now() - s.lastBackendContact > 60_000) {
      s.localFailsafe = true;
      note(s, 'backend lost for 60 s: entering local fail-safe');
      s.model.localSafeStop(Date.now());
    }
    if (s.localFailsafe && Date.now() - s.lastBackendContact < 10_000) {
      s.localFailsafe = false;
      note(s, 'backend contact restored: leaving local fail-safe');
    }
  }
}, 200);

setInterval(() => {
  for (const s of sims.values()) {
    const hb = s.model.heartbeat(Date.now());
    if (hb) void post(s, { ...hb, controller_ts: new Date(hb.controller_ts).toISOString(), health: s.localFailsafe ? 'LOCAL_FAILSAFE' : 'OK' });
  }
}, 5000);

await app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`controller simulator for ${junctionIds.join(', ')} on :${PORT}, backend ${BACKEND}`);
