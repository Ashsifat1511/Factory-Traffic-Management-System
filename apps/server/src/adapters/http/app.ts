import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { configFromJson, type AckMessage, type OperatorCommand } from '@ftms/domain';
import type { ZodError, ZodTypeAny } from 'zod';
import { JunctionBusy } from '../../application/actor.js';
import { NotFound, type Runtime } from '../../application/runtime.js';
import type { Device, Role, Security, SessionUser } from '../postgres/security.js';
import type { Store } from '../postgres/store.js';
import { ackSchema, commandSchema, deviceStatusSchema, heartbeatSchema, loginSchema, sensorEventSchema, simSensorSchema } from './schemas.js';

export interface HttpDeps {
  runtime: Runtime;
  store: Store;
  security: Security;
  simulationMode: boolean;
  dashboardOrigin: string;
  cookieSecure: boolean;
  simulator?: { url: string; token: string };
}

declare module 'fastify' {
  interface FastifyRequest { user?: SessionUser; device?: Device }
}

const RANK: Record<Role, number> = { VIEWER: 1, OPERATOR: 2, ADMIN: 3 };
const COOKIE = 'ftms_session';

/** RFC 9457 problem details. */
function problem(reply: FastifyReply, status: number, code: string, detail?: string, errors?: unknown) {
  return reply.status(status).type('application/problem+json').send({
    type: `https://ftms.local/problems/${code.toLowerCase().replace(/_/g, '-')}`,
    title: code.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase()),
    status, code, ...(detail ? { detail } : {}), ...(errors ? { errors } : {}),
  });
}

const zodErrors = (e: ZodError) => e.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));

/** HTTP status for a domain outcome code that rejects a request. */
const OUTCOME_STATUS: Record<string, number> = {
  STALE_VERSION: 409, EMERGENCY_ACTIVE: 409, HOLD_ACTIVE: 409, CONTROLLER_UNAVAILABLE: 409, NOT_IN_MANUAL: 409,
  LEASE_LIMIT_REACHED: 409, RESUME_PRECONDITIONS_NOT_MET: 409, EVENT_ID_REUSED: 409,
  UNKNOWN_DIRECTION: 422, TIMESTAMP_IN_FUTURE: 422, QUEUE_CAPACITY_EXCEEDED: 422, UNKNOWN_COMMAND: 422,
  COMMAND_JUNCTION_MISMATCH: 422, VALIDATION_FAILED: 422,
};

export async function buildApp(deps: HttpDeps) {
  const { runtime, store, security } = deps;
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.authorization', 'req.headers.cookie'] },
    bodyLimit: 16 * 1024,
    genReqId: () => randomUUID(),
  });
  await app.register(cookie);
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, {
    max: 600, timeWindow: '1 minute',
    keyGenerator: (req) => (req.headers.authorization ? `dev:${req.headers.authorization.slice(-12)}` : req.ip),
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof NotFound) return problem(reply, 404, 'UNKNOWN_JUNCTION', err.message);
    if (err instanceof JunctionBusy) {
      reply.header('Retry-After', '1');
      return problem(reply, 503, 'JUNCTION_BUSY');
    }
    const e = err as { statusCode?: number; code?: string; message: string };
    if (e.statusCode === 429) return problem(reply, 429, 'RATE_LIMITED');
    if (e.statusCode === 413) return problem(reply, 413, 'PAYLOAD_TOO_LARGE');
    if (e.statusCode === 415) return problem(reply, 415, 'UNSUPPORTED_MEDIA_TYPE');
    if (e.statusCode === 400) return problem(reply, 400, 'MALFORMED_JSON', e.message);
    req.log.error(err);
    return problem(reply, 500, 'INTERNAL_ERROR');
  });

  // ---- authentication hooks
  const requireUser = (min: Role) => async (req: FastifyRequest, reply: FastifyReply) => {
    req.user = (await security.session(req.cookies[COOKIE])) ?? undefined;
    if (!req.user) return problem(reply, 401, 'UNAUTHENTICATED');
    if (RANK[req.user.role] < RANK[min]) return problem(reply, 403, 'FORBIDDEN', `Requires role ${min}`);
    if (req.method !== 'GET') {
      // CSRF: SameSite=Strict cookie + custom header + Origin check (plan §14.4)
      const origin = req.headers.origin;
      if (req.headers['x-ftms-request'] !== '1' || (origin && !deps.dashboardOrigin.split(',').includes(origin))) return problem(reply, 403, 'CSRF_CHECK_FAILED');
    }
  };
  const requireDevice = (kind: Device['kind']) => async (req: FastifyRequest, reply: FastifyReply) => {
    req.device = (await security.device(req.headers.authorization)) ?? undefined;
    if (!req.device) {
      await store.audit('SYSTEM', null, [{ type: 'SECURITY_EVENT', severity: 'SECURITY', details: { event: 'DEVICE_AUTH_FAILED', ip: req.ip, url: req.url } }], 'SYSTEM');
      return problem(reply, 401, 'UNAUTHENTICATED');
    }
    if (req.device.kind !== kind) return problem(reply, 403, 'DEVICE_NOT_BOUND', `This endpoint requires a ${kind} device`);
  };
  const requireSim = async (req: FastifyRequest, reply: FastifyReply) => {
    await requireUser('OPERATOR')(req, reply);
    if (reply.sent) return;
    if (!req.user?.simulationAllowed) return problem(reply, 403, 'FORBIDDEN', 'Simulation is not allowed for this user');
  };

  const parse = <S extends ZodTypeAny>(schema: S, body: unknown, reply: FastifyReply, req: FastifyRequest) => {
    const r = schema.safeParse(body);
    if (!r.success) {
      void store.reject({ endpoint: req.url, sourceId: req.device?.deviceId, remoteAddr: req.ip, reasonCode: 'VALIDATION_FAILED', payload: body });
      problem(reply, 422, 'VALIDATION_FAILED', 'Request body is invalid', zodErrors(r.error));
      return null;
    }
    return r.data as S['_output'];
  };
  const reject = (reply: FastifyReply, code: string, detail?: string) => problem(reply, OUTCOME_STATUS[code] ?? 422, code, detail);

  // ---- health
  app.get('/api/health/live', async () => ({ status: 'ok' }));
  app.get('/api/health/ready', async (_req, reply) => (runtime.ready ? { status: 'ready' } : reply.status(503).send({ status: 'recovering' })));

  // ---- auth
  app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = parse(loginSchema, req.body, reply, req);
    if (!body) return;
    const r = await security.login(body.username, body.password, req.ip, String(req.headers['user-agent'] ?? ''));
    if ('error' in r) return problem(reply, 401, r.error === 'LOCKED' ? 'ACCOUNT_LOCKED' : 'INVALID_CREDENTIALS');
    reply.setCookie(COOKIE, r.token, { httpOnly: true, sameSite: 'strict', secure: deps.cookieSecure, path: '/' });
    return reply.status(204).send();
  });
  app.post('/api/auth/logout', async (req, reply) => {
    const t = req.cookies[COOKIE];
    if (t) await security.logout(t);
    reply.clearCookie(COOKIE, { path: '/' });
    return reply.status(204).send();
  });
  app.get('/api/auth/me', { preHandler: requireUser('VIEWER') }, async (req) => ({
    username: req.user!.username, role: req.user!.role, simulation_allowed: req.user!.simulationAllowed, simulation_mode: deps.simulationMode,
  }));

  // ---- junctions
  app.get('/api/junctions', { preHandler: requireUser('VIEWER') }, async () => [...runtime.actors.keys()].map((id) => {
    const s = runtime.status(id);
    return { junction_id: id, name: runtime.actor(id).config.raw.name, mode: s.mode, health: s.health, phase: s.phase, queues: s.queues, controller_status: s.controller_status };
  }));
  app.post('/api/junctions', { preHandler: requireUser('ADMIN') }, async (req, reply) => {
    let cfg;
    try { cfg = configFromJson(req.body); } catch { return problem(reply, 422, 'INVALID_CONFIG', 'Body is not a junction configuration'); }
    const r = await runtime.createJunction(cfg, req.user!.username);
    if (!r.ok) return problem(reply, r.code === 'JUNCTION_EXISTS' ? 409 : 422, r.code, undefined, r.errors);
    return reply.status(201).header('Location', `/api/junctions/${cfg.junctionId}`).send(runtime.status(cfg.junctionId));
  });
  app.get<{ Params: { id: string } }>('/api/junctions/:id', { preHandler: requireUser('VIEWER') }, async (req) => {
    const a = runtime.actor(req.params.id);
    return { junction_id: req.params.id, config: a.config.raw, status: runtime.status(req.params.id) };
  });
  app.get<{ Params: { id: string } }>('/api/junctions/:id/status', { preHandler: requireUser('VIEWER') }, async (req) => runtime.status(req.params.id));
  app.get<{ Params: { id: string }; Querystring: { limit?: string; before?: string; type?: string; direction?: string } }>(
    '/api/junctions/:id/history', { preHandler: requireUser('VIEWER') }, async (req) => {
      runtime.actor(req.params.id);
      const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50)));
      return store.history(req.params.id, {
        limit, ...(req.query.before ? { before: Number(req.query.before) } : {}),
        ...(req.query.type ? { type: req.query.type } : {}), ...(req.query.direction ? { direction: req.query.direction } : {}),
      });
    });
  app.get<{ Params: { id: string } }>('/api/junctions/:id/alerts', { preHandler: requireUser('VIEWER') }, async (req) => runtime.status(req.params.id).alerts);

  // ---- operator commands
  app.post<{ Params: { id: string } }>('/api/junctions/:id/commands', { preHandler: requireUser('OPERATOR'), config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    runtime.actor(req.params.id);
    const body = parse(commandSchema, req.body, reply, req);
    if (!body) return;
    const { expected_version, ...rest } = body as { expected_version?: number; vehicle_id?: string } & Record<string, unknown>;
    const cmd = { ...rest, ...(rest.vehicle_id ? { vehicleId: rest.vehicle_id } : {}) } as unknown as OperatorCommand;
    const key = req.headers['idempotency-key'];
    const out = await runtime.operatorCommand(req.params.id, cmd, req.user!.username, {
      ...(expected_version !== undefined ? { expectedVersion: expected_version } : {}),
      ...(typeof key === 'string' ? { idempotencyKey: key.slice(0, 100) } : {}),
    });
    if (!out.ok) return reject(reply, out.code, out.detail);
    return reply.status(202).send({ request_id: out.request_id, status: 'ACCEPTED', junction_version: out.junction_version, ...(out.data ?? {}) });
  });

  // ---- device ingestion
  const ingestSensor = async (req: FastifyRequest, reply: FastifyReply, body: { event_id: string; junction_id: string; direction: string; event_type: 'VEHICLE_ARRIVED' | 'VEHICLE_CLEARED'; vehicle_id: string; vehicle_type?: string; sequence_no: number; timestamp: string }, sourceId: string, actorType: 'DEVICE' | 'SIMULATOR') => {
    if (!runtime.actors.has(body.junction_id)) {
      void store.reject({ endpoint: req.url, sourceId, remoteAddr: req.ip, reasonCode: 'UNKNOWN_JUNCTION', payload: body });
      return problem(reply, 422, 'UNKNOWN_JUNCTION', `Junction ${body.junction_id} does not exist`);
    }
    const out = await runtime.sensorEvent({
      eventId: body.event_id, junctionId: body.junction_id, direction: body.direction, eventType: body.event_type,
      vehicleId: body.vehicle_id, ...(body.vehicle_type ? { vehicleType: body.vehicle_type } : {}),
      sequenceNo: body.sequence_no, timestamp: Date.parse(body.timestamp),
    }, sourceId, actorType);
    const queues = runtime.status(body.junction_id).queues;
    if (out.duplicate) return reply.status(200).send({ event_id: body.event_id, duplicate: true, outcome: out.code, queues });
    if (!out.ok) {
      void store.reject({ endpoint: req.url, sourceId, remoteAddr: req.ip, reasonCode: out.code, payload: body });
      return reject(reply, out.code, out.detail);
    }
    return reply.status(201).send({ event_id: body.event_id, outcome: out.code, ...(out.detail ? { detail: out.detail } : {}), junction_version: runtime.actor(body.junction_id).snapshot.version, queues });
  };

  app.post('/api/sensor-events', { preHandler: requireDevice('SENSOR') }, async (req, reply) => {
    const body = parse(sensorEventSchema, req.body, reply, req);
    if (!body) return;
    const d = req.device!;
    if (d.junctionId !== body.junction_id || d.approach !== body.direction) {
      void store.reject({ endpoint: req.url, sourceId: d.deviceId, remoteAddr: req.ip, reasonCode: 'DEVICE_NOT_BOUND', payload: body });
      return problem(reply, 403, 'DEVICE_NOT_BOUND', `Device ${d.deviceId} may only report ${d.junctionId}/${d.approach}`);
    }
    return ingestSensor(req, reply, body, d.deviceId, 'DEVICE');
  });

  const ingestController = async (req: FastifyRequest, reply: FastifyReply, raw: Record<string, unknown>, sourceId: string, actorType: 'DEVICE' | 'SIMULATOR', boundJunction?: string) => {
    const type = raw.type ?? ('command_id' in raw ? 'ACK' : 'device_type' in raw ? 'DEVICE_STATUS' : 'aspects' in raw ? 'HEARTBEAT' : null);
    const junctionId = String(raw.junction_id ?? '');
    if (boundJunction && boundJunction !== junctionId) return problem(reply, 403, 'DEVICE_NOT_BOUND');
    if (type === 'ACK') {
      const b = parse(ackSchema, raw, reply, req);
      if (!b) return;
      runtime.actor(b.junction_id);
      const msg: AckMessage = { type: 'ACK', commandId: b.command_id, status: b.status, ...(b.actual_aspects ? { actualAspects: b.actual_aspects } : {}), ...(b.actual_state ? { actualState: b.actual_state } : {}), ...(b.reason ? { reason: b.reason } : {}) };
      const out = await runtime.controllerMessage(b.junction_id, msg, sourceId, actorType);
      if (!out.ok) return reject(reply, out.code);
      return { outcome: out.code };
    }
    if (type === 'HEARTBEAT') {
      const b = parse(heartbeatSchema, raw, reply, req);
      if (!b) return;
      runtime.actor(b.junction_id);
      const out = await runtime.controllerMessage(b.junction_id, { type: 'HEARTBEAT', aspects: b.aspects, lastAppliedCommandId: b.last_applied_command_id ?? null }, sourceId, actorType);
      return { outcome: out.code };
    }
    if (type === 'DEVICE_STATUS') {
      const b = parse(deviceStatusSchema, raw, reply, req);
      if (!b) return;
      runtime.actor(b.junction_id);
      const out = await runtime.deviceStatus({ eventId: b.event_id, junctionId: b.junction_id, deviceType: b.device_type, ...(b.direction ? { direction: b.direction } : {}), status: b.status, timestamp: Date.parse(b.timestamp) }, sourceId, actorType);
      if ((out as { duplicate?: boolean }).duplicate) return reply.status(200).send({ event_id: b.event_id, duplicate: true, outcome: out.code });
      if (!out.ok) return reject(reply, out.code, out.detail);
      return reply.status(201).send({ event_id: b.event_id, outcome: out.code });
    }
    return problem(reply, 422, 'VALIDATION_FAILED', 'Unknown controller message type');
  };

  app.post('/api/controller-events', { preHandler: requireDevice('CONTROLLER') }, async (req, reply) => {
    if (typeof req.body !== 'object' || req.body === null) return problem(reply, 422, 'VALIDATION_FAILED');
    return ingestController(req, reply, req.body as Record<string, unknown>, req.device!.deviceId, 'DEVICE', req.device!.junctionId);
  });

  // ---- live updates (SSE)
  app.get<{ Querystring: { junctions?: string } }>('/api/stream', { preHandler: requireUser('VIEWER') }, (req, reply) => {
    const wanted = req.query.junctions ? new Set(req.query.junctions.split(',')) : null;
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (event: string, data: unknown) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    for (const id of runtime.actors.keys()) if (!wanted || wanted.has(id)) send('status', runtime.status(id));
    const onChange = (e: { junctionId: string; status: unknown; audit: unknown[] }) => {
      if (wanted && !wanted.has(e.junctionId)) return;
      send('status', e.status);
      if (e.audit.length) send('audit', { junction_id: e.junctionId, entries: e.audit });
    };
    runtime.events.on('change', onChange);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);
    req.raw.on('close', () => { clearInterval(ping); runtime.events.off('change', onChange); });
  });

  // ---- admin
  app.post<{ Body: { device_id: string; kind: 'SENSOR' | 'CONTROLLER'; junction_id: string; approach?: string } }>('/api/admin/devices', { preHandler: requireUser('ADMIN') }, async (req, reply) => {
    const b = req.body;
    if (!b?.device_id || !['SENSOR', 'CONTROLLER'].includes(b.kind) || !runtime.actors.has(b.junction_id)) return problem(reply, 422, 'VALIDATION_FAILED');
    const key = await security.createDevice(b.device_id, b.kind, b.junction_id, b.approach ?? null);
    return reply.status(201).send({ device_id: b.device_id, key, note: 'Store this key now; it is not shown again.' });
  });
  app.delete<{ Params: { id: string } }>('/api/admin/devices/:id', { preHandler: requireUser('ADMIN') }, async (req, reply) => {
    await security.revokeDevice(req.params.id);
    return reply.status(204).send();
  });

  // ---- simulation (registered only in SIMULATION_MODE; plan §12.2, T-05)
  if (deps.simulationMode) {
    const seqs = new Map<string, number>();
    app.post('/api/sim/sensor-events', { preHandler: requireSim }, async (req, reply) => {
      const b = parse(simSensorSchema, req.body, reply, req);
      if (!b) return;
      const sourceId = `sim:${req.user!.username}:${b.direction}`;
      const seq = b.sequence_no ?? (seqs.get(sourceId) ?? 0) + 1;
      seqs.set(sourceId, Math.max(seq, seqs.get(sourceId) ?? 0));
      const ts = b.timestamp ?? new Date(Date.now() + (b.timestamp_offset_s ?? 0) * 1000).toISOString();
      return ingestSensor(req, reply, {
        event_id: b.event_id ?? `sim-${randomUUID()}`, junction_id: b.junction_id, direction: b.direction, event_type: b.event_type,
        vehicle_id: b.vehicle_id, ...(b.vehicle_type ? { vehicle_type: b.vehicle_type } : {}), sequence_no: seq, timestamp: ts,
      }, sourceId, 'SIMULATOR');
    });
    app.post('/api/sim/controller-events', { preHandler: requireSim }, async (req, reply) => {
      if (typeof req.body !== 'object' || req.body === null) return problem(reply, 422, 'VALIDATION_FAILED');
      return ingestController(req, reply, req.body as Record<string, unknown>, `sim:${req.user!.username}`, 'SIMULATOR');
    });
    const proxy = async (method: 'GET' | 'PUT', path: string, body: unknown, reply: FastifyReply) => {
      if (!deps.simulator) return problem(reply, 503, 'SIMULATOR_NOT_CONFIGURED');
      try {
        const res = await fetch(`${deps.simulator.url}${path}`, {
          method, headers: { 'content-type': 'application/json', 'x-backend-token': deps.simulator.token },
          ...(method === 'PUT' ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(2000),
        });
        return reply.status(res.status).send(await res.json());
      } catch {
        return problem(reply, 503, 'SIMULATOR_UNREACHABLE');
      }
    };
    app.get<{ Params: { id: string } }>('/api/sim/controllers/:id', { preHandler: requireSim }, (req, reply) => proxy('GET', `/junctions/${req.params.id}`, null, reply));
    app.put<{ Params: { id: string } }>('/api/sim/controllers/:id', { preHandler: requireSim }, (req, reply) => proxy('PUT', `/junctions/${req.params.id}`, req.body, reply));
  }

  return app;
}
