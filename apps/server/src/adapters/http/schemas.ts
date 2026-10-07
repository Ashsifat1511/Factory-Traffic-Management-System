import { z } from 'zod';

const id64 = z.string().min(1).max(64).regex(/^[A-Za-z0-9._:-]+$/);
const aspect = z.enum(['RED', 'YELLOW', 'GREEN']);
const iso = z.string().datetime({ offset: true });

/** Device payloads are tolerant: unknown extra fields are ignored (plan §5.1). */
export const sensorEventSchema = z.object({
  event_id: id64,
  junction_id: z.string().min(1).max(16),
  direction: z.string().min(1).max(32),
  event_type: z.enum(['VEHICLE_ARRIVED', 'VEHICLE_CLEARED']),
  vehicle_id: id64,
  vehicle_type: z.string().regex(/^[A-Z_]{1,32}$/).optional(),
  sequence_no: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  timestamp: iso,
}).refine((e) => e.event_type === 'VEHICLE_CLEARED' || e.vehicle_type !== undefined, { message: 'vehicle_type is required for VEHICLE_ARRIVED', path: ['vehicle_type'] });

export const ackSchema = z.object({
  type: z.literal('ACK').optional(),
  command_id: z.string().min(1).max(80),
  junction_id: z.string().min(1).max(16),
  status: z.enum(['ACK', 'NACK', 'FAILED']),
  actual_aspects: z.record(aspect).optional(),
  actual_state: aspect.optional(),
  reason: z.string().max(64).optional(),
});

export const heartbeatSchema = z.object({
  type: z.literal('HEARTBEAT').optional(),
  junction_id: z.string().min(1).max(16),
  aspects: z.record(aspect),
  last_applied_command_id: z.string().max(80).nullable().optional(),
  health: z.string().max(32).optional(),
});

export const deviceStatusSchema = z.object({
  type: z.literal('DEVICE_STATUS').optional(),
  event_id: id64,
  junction_id: z.string().min(1).max(16),
  device_type: z.enum(['SIGNAL_CONTROLLER', 'SIGNAL_HEAD', 'SENSOR']),
  direction: z.string().max(32).optional(),
  status: z.enum(['ONLINE', 'OFFLINE', 'DEGRADED', 'FAULT']),
  timestamp: iso,
});

const reason = z.string().min(1).max(200);
/** Operator commands are strict: unknown fields are rejected (mass-assignment protection). */
export const commandSchema = z.discriminatedUnion('command', [
  z.object({ command: z.literal('MANUAL_GREEN_REQUEST'), direction: z.string().max(32), reason: reason.default('manual request'), expected_version: z.number().int().optional() }).strict(),
  z.object({ command: z.literal('RETURN_TO_AUTOMATIC'), reason: reason.optional(), expected_version: z.number().int().optional() }).strict(),
  z.object({ command: z.literal('EXTEND_MANUAL'), expected_version: z.number().int().optional() }).strict(),
  z.object({ command: z.literal('ALL_RED_HOLD'), reason, expected_version: z.number().int().optional() }).strict(),
  z.object({ command: z.literal('RELEASE_HOLD'), reason: reason.optional(), expected_version: z.number().int().optional() }).strict(),
  z.object({ command: z.literal('EMERGENCY_PREEMPT'), direction: z.string().max(32), reason, expected_version: z.number().int().optional() }).strict(),
  z.object({ command: z.literal('EMERGENCY_CANCEL'), vehicle_id: id64.optional(), reason, expected_version: z.number().int().optional() }).strict(),
  z.object({ command: z.literal('RESUME_AFTER_FAULT'), reason, expected_version: z.number().int().optional() }).strict(),
]);

export const loginSchema = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(256) }).strict();

export const simSensorSchema = z.object({
  event_id: id64.optional(),
  junction_id: z.string().min(1).max(16),
  direction: z.string().min(1).max(32),
  event_type: z.enum(['VEHICLE_ARRIVED', 'VEHICLE_CLEARED']),
  vehicle_id: id64,
  vehicle_type: z.string().regex(/^[A-Z_]{1,32}$/).optional(),
  sequence_no: z.number().int().min(0).optional(),
  timestamp: iso.optional(),
  timestamp_offset_s: z.number().int().min(-3600).max(3600).optional(),
}).strict();
