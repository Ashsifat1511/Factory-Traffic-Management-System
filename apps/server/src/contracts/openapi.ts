import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  ackSchema, commandSchema, createDeviceSchema, createUserSchema, deviceStatusSchema, heartbeatSchema, loginSchema,
  sensorEventSchema, simSensorSchema,
} from './schemas.js';

/** OpenAPI 3.1 document generated from the zod contracts (plan §12.5). Served at /docs; `npm run openapi:export` writes docs/openapi.json. */

const schema = (s: ZodTypeAny) => zodToJsonSchema(s, { target: 'openApi3', $refStrategy: 'none' });
const body = (s: ZodTypeAny) => ({ required: true, content: { 'application/json': { schema: schema(s) } } });
const problem = { content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } };
const json = (description: string) => ({ description, content: { 'application/json': { schema: { type: 'object' } } } });
const errors = (...codes: number[]) => Object.fromEntries(codes.map((c) => [String(c), { description: ERROR_TEXT[c] ?? 'Error', ...problem }]));
const ERROR_TEXT: Record<number, string> = {
  400: 'Malformed JSON', 401: 'Not authenticated', 403: 'Not allowed (role, CSRF or device binding)', 404: 'Unknown junction or route',
  409: 'Conflicts with the current state', 422: 'Well-formed but invalid', 429: 'Rate limited', 503: 'Junction busy or not ready',
};
const session = [{ session: [] }];
const device = [{ deviceKey: [] }];
const junctionId = { name: 'id', in: 'path', required: true, schema: { type: 'string', example: 'A' } };

export function openApiDocument(opts: { simulationMode: boolean }) {
  const paths: Record<string, Record<string, unknown>> = {
    '/api/auth/login': { post: { tags: ['auth'], summary: 'Log in; sets the httpOnly session cookie', requestBody: body(loginSchema), responses: { 204: { description: 'Logged in' }, ...errors(401, 422, 429) } } },
    '/api/auth/logout': { post: { tags: ['auth'], summary: 'Log out', security: session, responses: { 204: { description: 'Logged out' } } } },
    '/api/auth/me': { get: { tags: ['auth'], summary: 'Current user and role', security: session, responses: { 200: json('User'), ...errors(401) } } },
    '/api/junctions': {
      get: { tags: ['junctions'], summary: 'List junctions with a summary', security: session, responses: { 200: json('Junction summaries'), ...errors(401) } },
      post: { tags: ['junctions'], summary: 'Create a junction from a validated config (ADMIN)', security: session, requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', description: 'Same shape as config/junctions/A.json' } } } }, responses: { 201: json('Created; Location header points at the junction'), ...errors(401, 403, 409, 422) } },
    },
    '/api/junctions/{id}': { get: { tags: ['junctions'], summary: 'Config and status', security: session, parameters: [junctionId], responses: { 200: json('Junction'), ...errors(401, 404) } } },
    '/api/junctions/{id}/status': { get: { tags: ['junctions'], summary: 'Live state (superset of spec §10.3: desired vs actual, pending command, alerts, allowed_commands)', security: session, parameters: [junctionId], responses: { 200: json('Status'), ...errors(401, 404) } } },
    '/api/junctions/{id}/commands': {
      post: {
        tags: ['commands'], summary: 'Operator command (OPERATOR). Executes asynchronously through confirmed steps.', security: session,
        parameters: [junctionId, { name: 'x-ftms-request', in: 'header', required: true, schema: { const: '1' } }, { name: 'Idempotency-Key', in: 'header', schema: { type: 'string', maxLength: 100 } }],
        requestBody: body(commandSchema), responses: { 202: json('Accepted: request_id and junction_version'), ...errors(401, 403, 404, 409, 422, 429, 503) },
      },
    },
    '/api/junctions/{id}/history': {
      get: {
        tags: ['junctions'], summary: 'Audit entries, newest first (keyset pagination)', security: session,
        parameters: [junctionId, ...['limit', 'before', 'type', 'direction', 'from', 'to'].map((name) => ({ name, in: 'query', schema: { type: 'string' } }))],
        responses: { 200: json('Audit entries'), ...errors(401, 404, 422) },
      },
    },
    '/api/junctions/{id}/explain': { get: { tags: ['junctions'], summary: 'Why the junction is in its current state: last confirmed command, the decision that requested it and its trigger', security: session, parameters: [junctionId], responses: { 200: json('Explanation'), ...errors(401, 404) } } },
    '/api/junctions/{id}/alerts': { get: { tags: ['junctions'], summary: 'Active alerts', security: session, parameters: [junctionId], responses: { 200: json('Alerts'), ...errors(401, 404) } } },
    '/api/stream': { get: { tags: ['junctions'], summary: 'Server-Sent Events: status, audit (id <junction>:<seq>, replayed after Last-Event-ID)', security: session, responses: { 200: { description: 'text/event-stream' }, ...errors(401, 429) } } },
    '/api/sensor-events': { post: { tags: ['devices'], summary: 'Vehicle event from a sensor (201 new, 200 duplicate, 409 event_id reused)', security: device, requestBody: body(sensorEventSchema), responses: { 200: json('Duplicate'), 201: json('Recorded'), ...errors(401, 403, 409, 422, 429, 503) } } },
    '/api/controller-events': {
      post: {
        tags: ['devices'], summary: 'ACK / NACK / FAILED / HEARTBEAT / DEVICE_STATUS from a controller', security: device,
        requestBody: { required: true, content: { 'application/json': { schema: { oneOf: [schema(ackSchema), schema(heartbeatSchema), schema(deviceStatusSchema)] } } } },
        responses: { 200: json('Processed'), 201: json('Device status recorded'), ...errors(401, 403, 409, 422) },
      },
    },
    '/api/admin/users': { post: { tags: ['admin'], summary: 'Create a user (ADMIN)', security: session, requestBody: body(createUserSchema), responses: { 201: json('Created'), ...errors(401, 403, 409, 422) } } },
    '/api/admin/devices': { post: { tags: ['admin'], summary: 'Issue a device key; returned once (ADMIN)', security: session, requestBody: body(createDeviceSchema), responses: { 201: json('Key issued'), ...errors(401, 403, 422) } } },
    '/api/admin/devices/{id}': { delete: { tags: ['admin'], summary: 'Revoke a device (ADMIN)', security: session, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 204: { description: 'Revoked' }, ...errors(401, 403) } } },
    '/api/health/live': { get: { tags: ['health'], summary: 'Process is up', responses: { 200: json('ok') } } },
    '/api/health/ready': { get: { tags: ['health'], summary: 'Database, recovery and (with MQTT) broker ready', responses: { 200: json('ready'), 503: json('not ready') } } },
  };
  if (opts.simulationMode) {
    Object.assign(paths, {
      '/api/sim/sensor-events': { post: { tags: ['simulation'], summary: 'Inject a sensor event as sim:<user>; fills in event_id, sequence_no and timestamp', security: session, requestBody: body(simSensorSchema), responses: { 200: json('Duplicate'), 201: json('Recorded'), ...errors(401, 403, 409, 422) } } },
      '/api/sim/controller-events': { post: { tags: ['simulation'], summary: 'Inject a raw controller message', security: session, responses: { 200: json('Processed'), ...errors(401, 403, 422) } } },
      '/api/sim/controllers/{id}': {
        get: { tags: ['simulation'], summary: 'Simulator settings and fault switches', security: session, parameters: [junctionId], responses: { 200: json('Settings'), ...errors(401, 403, 503) } },
        put: { tags: ['simulation'], summary: 'Change latency, faults or send a device status', security: session, parameters: [junctionId], responses: { 200: json('Settings'), ...errors(401, 403, 503) } },
      },
    });
  }
  return {
    openapi: '3.1.0',
    info: { title: 'Factory Traffic Management System API', version: '1.0.0', description: 'Errors are RFC 9457 problem details with a stable `code`. See README and plan.md §12.' },
    servers: [{ url: '/' }],
    components: {
      securitySchemes: {
        session: { type: 'apiKey', in: 'cookie', name: 'ftms_session' },
        deviceKey: { type: 'http', scheme: 'bearer', description: 'Per-device key bound to a junction (and approach for sensors)' },
      },
      schemas: {
        Problem: {
          type: 'object', required: ['type', 'title', 'status', 'code'],
          properties: { type: { type: 'string' }, title: { type: 'string' }, status: { type: 'integer' }, code: { type: 'string' }, detail: { type: 'string' }, errors: { type: 'array', items: { type: 'object' } } },
        },
      },
    },
    paths,
  };
}
