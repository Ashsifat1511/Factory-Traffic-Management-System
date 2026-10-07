import type { AckMessage, DeviceStatus, HeartbeatMessage, SensorEvent } from '@ftms/domain';
import type { z } from 'zod';
import type { ackSchema, deviceStatusSchema, heartbeatSchema, sensorEventSchema } from './schemas.js';

/** Wire (snake_case) → domain mapping shared by the HTTP routes and the MQTT inbound adapter. */
export type SensorBody = z.infer<typeof sensorEventSchema>;

export const toSensorEvent = (b: SensorBody): SensorEvent => ({
  eventId: b.event_id, junctionId: b.junction_id, direction: b.direction, eventType: b.event_type,
  vehicleId: b.vehicle_id, ...(b.vehicle_type ? { vehicleType: b.vehicle_type } : {}),
  sequenceNo: b.sequence_no, timestamp: Date.parse(b.timestamp),
});

export const toAck = (b: z.infer<typeof ackSchema>): AckMessage => ({
  type: 'ACK', commandId: b.command_id, status: b.status,
  ...(b.actual_aspects ? { actualAspects: b.actual_aspects } : {}), ...(b.actual_state ? { actualState: b.actual_state } : {}),
  ...(b.reason ? { reason: b.reason } : {}),
});

export const toHeartbeat = (b: z.infer<typeof heartbeatSchema>): HeartbeatMessage => ({
  type: 'HEARTBEAT', aspects: b.aspects, lastAppliedCommandId: b.last_applied_command_id ?? null,
});

export const toDeviceStatus = (b: z.infer<typeof deviceStatusSchema>): DeviceStatus => ({
  eventId: b.event_id, junctionId: b.junction_id, deviceType: b.device_type,
  ...(b.direction ? { direction: b.direction } : {}), status: b.status, timestamp: Date.parse(b.timestamp),
});
