export type Aspect = 'RED' | 'YELLOW' | 'GREEN';
export type AspectVector = Record<string, Aspect>;
export type Instant = number;

export const VEHICLE_TYPES = ['EMERGENCY', 'TRUCK', 'MATERIAL_CARRIER', 'FORKLIFT', 'EMPLOYEE_VEHICLE', 'UNKNOWN'] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];

export type Interval =
  | { kind: 'UNKNOWN' }
  | { kind: 'GREEN'; phase: string; since: Instant; blocksEvaluated: number }
  | { kind: 'YELLOW'; phase: string; since: Instant }
  | { kind: 'ALL_RED'; since: Instant; lastPhase: string | null };

export type Step = 'GREEN' | 'YELLOW' | 'ALL_RED' | 'SAFE_STOP';
export type CommandCause = 'SCHEDULER' | 'EMERGENCY' | 'MANUAL' | 'HOLD' | 'RECOVERY' | 'FAULT';

export interface PendingCommand {
  commandId: string;
  seq: number;
  epoch: number;
  kind: 'SET_ASPECTS' | 'SAFE_STOP';
  step: Step;
  phase: string | null;
  target: AspectVector | null;
  attempt: number;
  issuedAt: Instant;
  ackDeadline: Instant;
  expiresAt: Instant;
  cause: CommandCause;
}

export type FaultCode =
  | 'CONTROLLER_OFFLINE' | 'CONTROLLER_UNRESPONSIVE' | 'COMMAND_REJECTED' | 'STATE_MISMATCH'
  | 'UNSAFE_STATE_REPORTED' | 'SIGNAL_HEAD_FAULT' | 'SAFETY_GUARD_TRIPPED' | 'STATE_UNKNOWN'
  | 'SENSOR_OFFLINE' | 'SENSOR_SUSPECT' | 'CLOCK_SKEW';

export interface Fault { code: FaultCode; subject?: string; since: Instant; detail?: string }

export type Health = 'OK' | 'DEGRADED' | 'FAILED' | 'UNKNOWN';
export type ControlMode = 'AUTOMATIC' | 'MANUAL' | 'EMERGENCY' | 'HOLD';

export interface QueuedVehicle {
  vehicleId: string; type: VehicleType; approach: string; queuedAt: Instant;
  sensorTs: Instant; sourceId: string; seq: number; eventId: string;
}

export interface VehicleMark {
  eventType: 'VEHICLE_ARRIVED' | 'VEHICLE_CLEARED';
  sourceId: string; seq: number; sensorTs: Instant; receivedAt: Instant;
}

export interface Emergency {
  id: string; vehicleId: string; approach: string; phase: string; source: 'SENSOR' | 'OPERATOR';
  sourceId: string; detectedAt: Instant; lastSeenAt: Instant; expiresAt: Instant; absoluteDeadline: Instant;
  servedSince: Instant | null;
}

export interface ManualOverride { requestId: string; phase: string; by: string; reason: string; startedAt: Instant; leaseExpiresAt: Instant }
export interface Hold { by: string; reason: string; since: Instant; requestId: string }

export interface SensorStream { sourceId: string; approach: string; highWaterSeq: number; lastSensorTs: Instant; recentGaps: number[] }

export interface JunctionState {
  junctionId: string;
  configVersion: number;
  version: number;
  epoch: number;
  commandSeq: number;
  interval: Interval;
  desired: AspectVector;
  confirmed: { aspects: AspectVector; at: Instant; via: 'ACK' | 'HEARTBEAT' | 'ACK_SHORTHAND' } | null;
  allRedConfirmedAt: Instant | null;
  pending: PendingCommand | null;
  lastAckedCommandId: string | null;
  faults: Fault[];
  hold: Hold | null;
  emergencies: Emergency[];
  manual: ManualOverride | null;
  queues: Record<string, QueuedVehicle[]>;
  marks: Record<string, VehicleMark>;
  sensors: Record<string, SensorStream>;
  headStatus: Record<string, 'ONLINE' | 'OFFLINE'>;
  cooldowns: Record<string, Instant>;
  controller: { link: 'ONLINE' | 'OFFLINE' | 'UNKNOWN'; lastHeartbeatAt: Instant | null; commissioned: boolean; lastSafeStopAt: Instant | null };
  lastServedAt: Record<string, Instant>;
  wakeToken: number;
}

// ---- inputs ----
export interface SensorEvent {
  eventId: string; junctionId: string; direction: string;
  eventType: 'VEHICLE_ARRIVED' | 'VEHICLE_CLEARED';
  vehicleId: string; vehicleType?: string; sequenceNo: number; timestamp: Instant;
}
export interface DeviceStatus {
  eventId: string; junctionId: string; deviceType: 'SIGNAL_CONTROLLER' | 'SIGNAL_HEAD' | 'SENSOR';
  direction?: string; status: 'ONLINE' | 'OFFLINE' | 'DEGRADED' | 'FAULT'; timestamp: Instant;
}
export type OperatorCommand =
  | { command: 'MANUAL_GREEN_REQUEST'; direction: string; reason: string }
  | { command: 'RETURN_TO_AUTOMATIC'; reason?: string }
  | { command: 'EXTEND_MANUAL' }
  | { command: 'ALL_RED_HOLD'; reason: string }
  | { command: 'RELEASE_HOLD'; reason?: string }
  | { command: 'EMERGENCY_PREEMPT'; direction: string; reason: string }
  | { command: 'EMERGENCY_CANCEL'; vehicleId?: string; reason: string }
  | { command: 'RESUME_AFTER_FAULT'; reason: string };

export interface AckMessage {
  type: 'ACK'; commandId: string; status: 'ACK' | 'NACK' | 'FAILED';
  actualAspects?: AspectVector; actualState?: Aspect; reason?: string;
}
export interface HeartbeatMessage { type: 'HEARTBEAT'; aspects: AspectVector; lastAppliedCommandId: string | null; health?: string }

export type Input =
  | { kind: 'SENSOR_EVENT'; event: SensorEvent; sourceId: string }
  | { kind: 'DEVICE_STATUS'; status: DeviceStatus; sourceId: string }
  | { kind: 'OPERATOR_COMMAND'; command: OperatorCommand; actor: string; requestId: string; expectedVersion?: number }
  | { kind: 'CONTROLLER_MESSAGE'; message: AckMessage | HeartbeatMessage }
  | { kind: 'WAKE'; token: number }
  | { kind: 'RECOVER' };

export type Effect =
  | { type: 'SEND_COMMAND'; command: PendingCommand; junctionId: string }
  | { type: 'SCHEDULE_WAKE'; at: Instant; token: number };

export type Severity = 'INFO' | 'WARNING' | 'CRITICAL' | 'SECURITY';
export interface AuditRecord {
  type: string; severity: Severity; direction?: string;
  previous?: unknown; next?: unknown; correlationId?: string; details?: Record<string, unknown>;
}

export interface Outcome { ok: boolean; code: string; detail?: string; data?: Record<string, unknown> }

export interface Decision { state: JunctionState; effects: Effect[]; audit: AuditRecord[]; outcome: Outcome }
