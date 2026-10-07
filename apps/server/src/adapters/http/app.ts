import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { configFromJson, type OperatorCommand } from '@ftms/domain';
import type { ZodError, ZodTypeAny } from 'zod';
import { JunctionBusy } from '../../application/actor.js';
import { NotFound, type Runtime } from '../../application/runtime.js';
import type { Device, Role, Security, SessionUser } from '../postgres/security.js';
import type { Store } from '../postgres/store.js';
import { openApiDocument } from '../../contracts/openapi.js';
import { toAck, toDeviceStatus, toHeartbeat, toSensorEvent, type SensorBody } from '../../contracts/ingest.js';
import {
  ackSchema, commandSchema, createDeviceSchema, createUserSchema, deviceStatusSchema, heartbeatSchema, historyQuerySchema, loginSchema,
  sensorEventSchema, simSensorSchema,
} from '../../contracts/schemas.js';

export interface HttpDeps {
  runtime: Runtime;
  store: Store;
  security: Security;
  simulationMode: boolean;
  dashboardOrigin: string;
  cookieSecure: boolean;
  simulator?: { url: string; token: string };
  /** Present when CONTROLLER_TRANSPORT=mqtt: readiness includes the broker connection (plan §17). */
  brokerConnected?: () => boolean;
  /** In production the API docs are ADMIN-only (plan §12.2). */
  production?: boolean;
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
  // ---- API docs (Swagger UI from the zod contracts)
  await app.register(swagger, { mode: 'static', specification: { document: openApiDocument({ simulationMode: deps.simulationMode }) as never } });
  await app.register(swaggerUi, { routePrefix: '/docs', ...(deps.production ? { uiHooks: { onRequest: requireUser('ADMIN') } } : {}) });

  const reject = (reply: FastifyReply, code: string, detail?: string) => problem(reply, OUTCOME_STATUS[code] ?? 422, code, detail);

  // ---- health
  app.get('/api/health/live', async () => ({ status: 'ok' }));
  app.get('/api/health/ready', async (_req, reply) => {
    if (!runtime.ready) return reply.status(503).send({ status: 'recovering' });
    if (deps.brokerConnected && !deps.brokerConnected()) return reply.status(503).send({ status: 'broker_disconnected' });
    return { status: 'ready' };
  });

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
  app.get<{ Params: { id: string } }>('/api/junctions/:id/history', { preHandler: requireUser('VIEWER') }, async (req, reply) => {
    runtime.actor(req.params.id);
    const q = parse(historyQuerySchema, req.query, reply, req);
    if (!q) return;
    return store.history(req.params.id, {
      limit: q.limit, ...(q.before ? { before: q.before } : {}), ...(q.type ? { type: q.type } : {}),
      ...(q.direction ? { direction: q.direction } : {}), ...(q.from ? { from: new Date(q.from) } : {}), ...(q.to ? { to: new Date(q.to) } : {}),
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
    return reply.status(202).send({ request_id: out.request_id, status: 'ACCEPTED', junction_version: out.junction_version, ...out.data });
  });

  // ---- device ingestion
  const ingestSensor = async (req: FastifyRequest, reply: FastifyReply, body: SensorBody, sourceId: string, actorType: 'DEVICE' | 'SIMULATOR') => {
    if (!runtime.actors.has(body.junction_id)) {
      void store.reject({ endpoint: req.url, sourceId, remoteAddr: req.ip, reasonCode: 'UNKNOWN_JUNCTION', payload: body });
      return problem(reply, 422, 'UNKNOWN_JUNCTION', `Junction ${body.junction_id} does not exist`);
    }
    const out = await runtime.sensorEvent(toSensorEvent(body), sourceId, actorType);
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
      const msg = toAck(b);
      const out = await runtime.controllerMessage(b.junction_id, msg, sourceId, actorType);
      if (!out.ok) return reject(reply, out.code);
      return { outcome: out.code };
    }
    if (type === 'HEARTBEAT') {
      const b = parse(heartbeatSchema, raw, reply, req);
      if (!b) return;
      runtime.actor(b.junction_id);
      const out = await runtime.controllerMessage(b.junction_id, toHeartbeat(b), sourceId, actorType);
      return { outcome: out.code };
    }
    if (type === 'DEVICE_STATUS') {
      const b = parse(deviceStatusSchema, raw, reply, req);
      if (!b) return;
      runtime.actor(b.junction_id);
      const out = await runtime.deviceStatus(toDeviceStatus(b), sourceId, actorType);
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

  // ---- live updates (SSE, plan §12.4)
  const streams = { total: 0, perSession: new Map<string, number>() };
  app.get<{ Querystring: { junctions?: string } }>('/api/stream', { preHandler: requireUser('VIEWER') }, async (req, reply) => {
    const session = req.user!.userId;
    const mine = streams.perSession.get(session) ?? 0;
    if (streams.total >= 200 || mine >= 5) {
      reply.header('Retry-After', '10');
      return problem(reply, 429, 'TOO_MANY_STREAMS', 'At most 5 live streams per session and 200 in total');
    }
    streams.total += 1;
    streams.perSession.set(session, mine + 1);

    const wanted = [...runtime.actors.keys()].filter((id) => !req.query.junctions || req.query.junctions.split(',').includes(id));
    // Last-Event-ID is `<junction>:<chain_seq>` of the last audit entry the browser saw; replay what it missed.
    const lastId = /^([A-Za-z0-9_-]+):(\d+)$/.exec(String(req.headers['last-event-id'] ?? ''));
    const cursor = new Map<string, number>();
    for (const id of wanted) cursor.set(id, lastId && lastId[1] === id ? Number(lastId[2]) : await store.lastSeq(id));

    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (event: string, data: unknown, id?: string) => reply.raw.write(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const pushAudit = async (j: string) => {
      const rows = await store.auditAfter(j, cursor.get(j) ?? 0);
      if (!rows.length) return;
      cursor.set(j, rows[rows.length - 1]!.chain_seq);
      const entries = rows.map((r) => ({
        seq: r.chain_seq, at: r.occurred_at, type: r.event_type, severity: r.severity, ...(r.direction ? { direction: r.direction } : {}),
        ...(r.correlation_id ? { correlationId: r.correlation_id } : {}), actor: r.actor_id ?? r.actor_type, details: r.details,
      }));
      send('audit', { junction_id: j, entries }, `${j}:${cursor.get(j)}`);
    };
    for (const id of wanted) send('status', runtime.status(id));
    for (const id of wanted) if (lastId?.[1] === id) await pushAudit(id);

    // Bursts are merged to at most 5 updates per second per junction.
    const timers = new Map<string, NodeJS.Timeout>();
    const flush = (j: string) => {
      timers.delete(j);
      send('status', runtime.status(j));
      void pushAudit(j).catch(() => undefined);
    };
    const onChange = (e: { junctionId: string }) => {
      if (!wanted.includes(e.junctionId) || timers.has(e.junctionId)) return;
      timers.set(e.junctionId, setTimeout(() => flush(e.junctionId), 200));
    };
    runtime.events.on('change', onChange);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      for (const t of timers.values()) clearTimeout(t);
      runtime.events.off('change', onChange);
      streams.total -= 1;
      streams.perSession.set(session, (streams.perSession.get(session) ?? 1) - 1);
    });
  });

  // ---- admin
  app.post('/api/admin/users', { preHandler: requireUser('ADMIN') }, async (req, reply) => {
    const b = parse(createUserSchema, req.body, reply, req);
    if (!b) return;
    if (await security.userExists(b.username)) return problem(reply, 409, 'USER_EXISTS');
    await security.createUser(b.username, b.password, b.role, b.simulation_allowed);
    await store.audit('SYSTEM', null, [{ type: 'SECURITY_EVENT', severity: 'SECURITY', details: { event: 'USER_CREATED', username: b.username, role: b.role, by: req.user!.username } }], 'OPERATOR', req.user!.username);
    return reply.status(201).send({ username: b.username, role: b.role, simulation_allowed: b.simulation_allowed });
  });
  app.post('/api/admin/devices', { preHandler: requireUser('ADMIN') }, async (req, reply) => {
    const b = parse(createDeviceSchema, req.body, reply, req);
    if (!b) return;
    if (!runtime.actors.has(b.junction_id)) return problem(reply, 422, 'UNKNOWN_JUNCTION');
    if (b.approach && !runtime.actor(b.junction_id).config.approaches.includes(b.approach)) return problem(reply, 422, 'UNKNOWN_DIRECTION');
    const key = await security.createDevice(b.device_id, b.kind, b.junction_id, b.approach ?? null);
    await store.audit('SYSTEM', null, [{ type: 'SECURITY_EVENT', severity: 'SECURITY', details: { event: 'DEVICE_KEY_ISSUED', deviceId: b.device_id, by: req.user!.username } }], 'OPERATOR', req.user!.username);
    return reply.status(201).send({ device_id: b.device_id, key, note: 'Store this key now; it is not shown again.' });
  });
  app.delete<{ Params: { id: string } }>('/api/admin/devices/:id', { preHandler: requireUser('ADMIN') }, async (req, reply) => {
    await security.revokeDevice(req.params.id);
    await store.audit('SYSTEM', null, [{ type: 'SECURITY_EVENT', severity: 'SECURITY', details: { event: 'DEVICE_REVOKED', deviceId: req.params.id, by: req.user!.username } }], 'OPERATOR', req.user!.username);
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
