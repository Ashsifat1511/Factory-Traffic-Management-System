import type { CompiledConfig } from './config.js';
import { assertSafeCommand, hasConflictingPermissive, UnsafeCommand } from './guard.js';
import { chooseFromAllRed, scorePhases } from './scheduler.js';
import {
  VEHICLE_TYPES,
  type AckMessage, type Aspect, type AspectVector, type AuditRecord, type CommandCause, type ControlMode,
  type Decision, type DeviceStatus, type Effect, type Emergency, type FaultCode, type Health, type HeartbeatMessage,
  type Input, type Instant, type JunctionState, type OperatorCommand, type Outcome, type PendingCommand,
  type SensorEvent, type Step, type VehicleType,
} from './types.js';

export interface DecideContext {
  config: CompiledConfig;
  now: Instant;
  newId: (prefix: string) => string;
}

const FAILED_FAULTS: FaultCode[] = [
  'CONTROLLER_OFFLINE', 'CONTROLLER_UNRESPONSIVE', 'COMMAND_REJECTED', 'STATE_MISMATCH',
  'UNSAFE_STATE_REPORTED', 'SIGNAL_HEAD_FAULT', 'SAFETY_GUARD_TRIPPED',
];
/** Faults that only an operator may clear with RESUME_AFTER_FAULT (plan §3.7). */
export const OPERATOR_RESUME_FAULTS: FaultCode[] = [
  'COMMAND_REJECTED', 'STATE_MISMATCH', 'UNSAFE_STATE_REPORTED', 'SIGNAL_HEAD_FAULT', 'SAFETY_GUARD_TRIPPED',
];
const COMMS_FAULTS: FaultCode[] = ['CONTROLLER_OFFLINE', 'CONTROLLER_UNRESPONSIVE'];

// ---------------------------------------------------------------- derived views

export function health(s: JunctionState): Health {
  if (s.faults.some((f) => FAILED_FAULTS.includes(f.code))) return 'FAILED';
  if (s.faults.some((f) => f.code === 'STATE_UNKNOWN')) return 'UNKNOWN';
  if (s.faults.length > 0) return 'DEGRADED';
  return 'OK';
}

export function controlMode(s: JunctionState, now: Instant): ControlMode {
  if (s.hold) return 'HOLD';
  if (s.emergencies.length > 0) return 'EMERGENCY';
  if (s.manual && s.manual.leaseExpiresAt > now) return 'MANUAL';
  return 'AUTOMATIC';
}

/** The single `mode` field from spec §10.3. */
export function specMode(s: JunctionState, now: Instant): string {
  const h = health(s);
  if (h === 'FAILED') return 'FAILURE';
  if (h === 'UNKNOWN') return 'DEGRADED';
  return controlMode(s, now);
}

export function allowedCommands(s: JunctionState, now: Instant): string[] {
  const h = health(s);
  const usable = h === 'OK' || h === 'DEGRADED';
  const out: string[] = ['ALL_RED_HOLD'];
  if (usable && s.emergencies.length === 0 && !s.hold) out.push('MANUAL_GREEN_REQUEST');
  if (s.manual && s.manual.leaseExpiresAt > now) out.push('RETURN_TO_AUTOMATIC', 'EXTEND_MANUAL');
  if (s.hold) out.push('RELEASE_HOLD');
  if (usable) out.push('EMERGENCY_PREEMPT');
  if (s.emergencies.length > 0) out.push('EMERGENCY_CANCEL');
  if (s.faults.some((f) => OPERATOR_RESUME_FAULTS.includes(f.code))) out.push('RESUME_AFTER_FAULT');
  return out;
}

export function phaseOfApproach(cfg: CompiledConfig, approach: string): string | null {
  return cfg.phases.find((p) => p.approaches.includes(approach))?.id ?? null;
}

export function allRed(cfg: CompiledConfig): AspectVector {
  return Object.fromEntries(cfg.groupIds.map((g) => [g, 'RED' as Aspect]));
}

function phaseVector(cfg: CompiledConfig, phase: string, aspect: Aspect): AspectVector {
  const p = cfg.phases.find((x) => x.id === phase)!;
  return Object.fromEntries(cfg.groupIds.map((g) => [g, p.groups.has(g) ? aspect : 'RED']));
}

const sameVector = (a: AspectVector, b: AspectVector) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};

export function initialState(cfg: CompiledConfig, now: Instant): JunctionState {
  return {
    junctionId: cfg.junctionId,
    configVersion: cfg.raw.version,
    version: 0,
    epoch: 0,
    commandSeq: 0,
    interval: { kind: 'UNKNOWN' },
    desired: allRed(cfg),
    confirmed: null,
    allRedConfirmedAt: null,
    pending: null,
    lastAckedCommandId: null,
    faults: [{ code: 'STATE_UNKNOWN', since: now }],
    hold: null,
    emergencies: [],
    manual: null,
    queues: Object.fromEntries(cfg.approaches.map((a) => [a, []])),
    marks: {},
    sensors: {},
    headStatus: Object.fromEntries(cfg.approaches.map((a) => [a, 'ONLINE' as const])),
    cooldowns: {},
    controller: { link: 'UNKNOWN', lastHeartbeatAt: null, commissioned: false, lastSafeStopAt: null },
    lastServedAt: {},
    wakeToken: 0,
  };
}

// ---------------------------------------------------------------- decide

class Run {
  effects: Effect[] = [];
  audit: AuditRecord[] = [];
  wakes: Instant[] = [];
  constructor(public ctx: DecideContext, public d: JunctionState) {}
  get cfg() { return this.ctx.config; }
  get now() { return this.ctx.now; }
  log(r: AuditRecord) { this.audit.push(r); }
  wake(at: Instant) { this.wakes.push(Math.max(at, this.now)); }
}

/**
 * The functional core (plan §3.8). Deterministic: no I/O, no clock reads.
 * Every input runs: the input handler, housekeeping (deadlines), then `drive` (what the signals do next).
 */
export function decide(ctx: DecideContext, state: JunctionState, input: Input): Decision {
  const d = structuredClone(state);
  const r = new Run(ctx, d);
  let outcome: Outcome = { ok: true, code: 'OK' };

  switch (input.kind) {
    case 'WAKE':
      if (input.token !== d.wakeToken) return { state, effects: [], audit: [], outcome: { ok: true, code: 'STALE_TIMER' } };
      break;
    case 'RECOVER': outcome = recover(r); break;
    case 'SENSOR_EVENT': outcome = sensorEvent(r, input.event, input.sourceId); break;
    case 'DEVICE_STATUS': outcome = deviceStatus(r, input.status); break;
    case 'CONTROLLER_MESSAGE':
      outcome = input.message.type === 'ACK' ? ack(r, input.message) : heartbeat(r, input.message);
      break;
    case 'OPERATOR_COMMAND':
      if (input.expectedVersion !== undefined && input.expectedVersion !== state.version) {
        outcome = { ok: false, code: 'STALE_VERSION', detail: `Junction is at version ${state.version}` };
        r.log({ type: 'OPERATOR_COMMAND_REJECTED', severity: 'INFO', correlationId: input.requestId, details: { command: input.command.command, code: outcome.code, actor: input.actor } });
      } else {
        outcome = operatorCommand(r, input.command, input.actor, input.requestId);
      }
      break;
  }

  housekeeping(r);
  drive(r);

  if (r.wakes.length > 0) {
    d.wakeToken += 1;
    r.effects.push({ type: 'SCHEDULE_WAKE', at: Math.min(...r.wakes), token: d.wakeToken });
  }
  if (r.audit.length > 0) d.version += 1;
  return { state: d, effects: r.effects, audit: r.audit, outcome };
}

// ---------------------------------------------------------------- faults

function raiseFault(r: Run, code: FaultCode, subject?: string, detail?: string, resetSafeStopGap = true) {
  const { d } = r;
  if (d.faults.some((f) => f.code === code && f.subject === subject)) return;
  d.faults.push({ code, since: r.now, ...(subject ? { subject } : {}), ...(detail ? { detail } : {}) });
  const severity = code === 'UNSAFE_STATE_REPORTED' || code === 'SAFETY_GUARD_TRIPPED' ? 'CRITICAL' : FAILED_FAULTS.includes(code) ? 'WARNING' : 'INFO';
  r.log({ type: 'FAULT_RAISED', severity, ...(subject ? { direction: subject } : {}), details: { code, detail } });
  if (resetSafeStopGap && FAILED_FAULTS.includes(code)) d.controller.lastSafeStopAt = null;
}

function clearFaults(r: Run, codes: FaultCode[], subject?: string) {
  const before = r.d.faults.length;
  const removed = r.d.faults.filter((f) => codes.includes(f.code) && (subject === undefined || f.subject === subject));
  r.d.faults = r.d.faults.filter((f) => !removed.includes(f));
  if (r.d.faults.length !== before) r.log({ type: 'FAULT_CLEARED', severity: 'INFO', details: { codes: removed.map((f) => f.code), subject } });
}

/** Physical state is no longer known: the backend must not command greens until a SAFE_STOP is confirmed. */
function markUnknown(r: Run) {
  r.d.interval = { kind: 'UNKNOWN' };
  r.d.confirmed = null;
  r.d.allRedConfirmedAt = null;
}

// ---------------------------------------------------------------- commands to the controller

function send(r: Run, step: Step, phase: string | null, cause: CommandCause): boolean {
  const { d, cfg, now } = r;
  const kind = step === 'SAFE_STOP' ? 'SAFE_STOP' : 'SET_ASPECTS';
  let target: AspectVector | null = null;
  if (step === 'GREEN') target = phaseVector(cfg, phase!, 'GREEN');
  else if (step === 'YELLOW') target = phaseVector(cfg, phase!, 'YELLOW');
  else if (step === 'ALL_RED') target = allRed(cfg);

  if (target) {
    try {
      assertSafeCommand(cfg, target, {
        now,
        confirmed: d.confirmed?.aspects ?? null,
        allRedConfirmedAt: d.allRedConfirmedAt,
        health: health(d),
        holdActive: d.hold !== null,
        commandPending: d.pending !== null,
      });
    } catch (e) {
      if (!(e instanceof UnsafeCommand)) throw e;
      r.log({ type: 'SAFETY_GUARD_TRIPPED', severity: 'CRITICAL', details: { reason: e.reason, ...e.details, step, phase } });
      raiseFault(r, 'SAFETY_GUARD_TRIPPED', undefined, e.reason);
      return false;
    }
  }
  d.commandSeq += 1;
  const ttl = kind === 'SAFE_STOP' ? cfg.ms.safeStopTtl : cfg.ms.commandTtl;
  const cmd: PendingCommand = {
    commandId: r.ctx.newId('cmd'), seq: d.commandSeq, epoch: d.epoch, kind, step, phase, target,
    attempt: 1, issuedAt: now, ackDeadline: now + cfg.ms.ackTimeout, expiresAt: now + ttl, cause,
  };
  d.pending = cmd;
  d.desired = target ?? allRed(cfg);
  if (kind === 'SAFE_STOP') d.controller.lastSafeStopAt = now;
  r.effects.push({ type: 'SEND_COMMAND', command: cmd, junctionId: d.junctionId });
  r.log({ type: 'SIGNAL_STATE_REQUESTED', severity: 'INFO', correlationId: cmd.commandId, next: d.desired, details: { step, phase, cause, seq: cmd.seq, epoch: cmd.epoch } });
  r.wake(cmd.ackDeadline);
  return true;
}

function confirm(r: Run, actual: AspectVector, via: 'ACK' | 'HEARTBEAT' | 'ACK_SHORTHAND') {
  const { d, now } = r;
  const p = d.pending!;
  const previous = d.confirmed?.aspects ?? null;
  for (const g of r.cfg.groupIds) {
    if (previous?.[g] !== actual[g]) {
      r.log({ type: 'SIGNAL_CHANGED', severity: 'INFO', direction: g, previous: previous?.[g] ?? 'UNKNOWN', next: actual[g], correlationId: p.commandId, details: { via } });
    }
  }
  const prevInterval = d.interval;
  d.confirmed = { aspects: actual, at: now, via };
  d.lastAckedCommandId = p.commandId;
  d.pending = null;
  if (p.step === 'SAFE_STOP' || p.step === 'ALL_RED') {
    const lastPhase = prevInterval.kind === 'YELLOW' || prevInterval.kind === 'GREEN' ? prevInterval.phase : null;
    d.interval = { kind: 'ALL_RED', since: now, lastPhase };
    d.allRedConfirmedAt = now;
    if (p.step === 'SAFE_STOP') {
      const wasUnknown = d.faults.some((f) => f.code === 'STATE_UNKNOWN');
      clearFaults(r, ['STATE_UNKNOWN', 'CONTROLLER_UNRESPONSIVE']);
      if (wasUnknown) r.log({ type: 'RECOVERY_COMPLETED', severity: 'INFO', correlationId: p.commandId });
    }
  } else if (p.step === 'YELLOW') {
    d.interval = { kind: 'YELLOW', phase: p.phase!, since: now };
    d.lastServedAt[p.phase!] = now;
  } else {
    d.interval = { kind: 'GREEN', phase: p.phase!, since: now, blocksEvaluated: 0 };
    for (const e of d.emergencies) if (e.phase === p.phase && e.servedSince === null) e.servedSince = now;
  }
}

// ---------------------------------------------------------------- controller messages

function ack(r: Run, m: AckMessage): Outcome {
  const { d, cfg } = r;
  const p = d.pending;
  if (!p || p.commandId !== m.commandId) {
    if (m.commandId === d.lastAckedCommandId) {
      r.log({ type: 'DUPLICATE_ACK', severity: 'INFO', correlationId: m.commandId });
      return { ok: true, code: 'DUPLICATE_ACK' };
    }
    r.log({ type: 'LATE_ACK', severity: 'WARNING', correlationId: m.commandId, details: { status: m.status } });
    if (m.actualAspects) observe(r, m.actualAspects);
    return { ok: true, code: 'LATE_OR_UNKNOWN_ACK' };
  }
  if (m.status !== 'ACK') {
    r.log({ type: 'CONTROLLER_NACK', severity: 'WARNING', correlationId: m.commandId, details: { status: m.status, reason: m.reason } });
    d.pending = null;
    markUnknown(r);
    if (m.actualAspects) d.confirmed = { aspects: m.actualAspects, at: r.now, via: 'ACK' };
    raiseFault(r, 'COMMAND_REJECTED', undefined, m.reason ?? m.status, p.kind !== 'SAFE_STOP');
    return { ok: true, code: 'COMMAND_REJECTED' };
  }
  const target = p.target ?? allRed(cfg);
  let actual: AspectVector | null = m.actualAspects ?? null;
  let via: 'ACK' | 'ACK_SHORTHAND' = 'ACK';
  if (!actual && m.actualState) {
    const stepState: Aspect = p.step === 'GREEN' ? 'GREEN' : p.step === 'YELLOW' ? 'YELLOW' : 'RED';
    if (m.actualState === stepState) { actual = target; via = 'ACK_SHORTHAND'; }
  }
  r.log({ type: 'CONTROLLER_ACK', severity: 'INFO', correlationId: m.commandId, next: actual, details: { via } });
  if (actual && hasConflictingPermissive(cfg, actual)) {
    d.pending = null;
    markUnknown(r);
    raiseFault(r, 'UNSAFE_STATE_REPORTED');
    return { ok: true, code: 'UNSAFE_STATE_REPORTED' };
  }
  if (actual && sameVector(actual, target)) {
    confirm(r, actual, via);
    return { ok: true, code: 'CONFIRMED' };
  }
  d.pending = null;
  markUnknown(r);
  if (actual) d.confirmed = { aspects: actual, at: r.now, via: 'ACK' };
  raiseFault(r, 'STATE_MISMATCH', undefined, 'ACK aspects differ from the command');
  return { ok: true, code: 'STATE_MISMATCH' };
}

/** A report that is not tied to the pending command: only checked for safety and consistency. */
function observe(r: Run, aspects: AspectVector) {
  const { d, cfg } = r;
  if (hasConflictingPermissive(cfg, aspects)) {
    d.pending = null;
    markUnknown(r);
    raiseFault(r, 'UNSAFE_STATE_REPORTED');
    return;
  }
  if (!d.pending && d.interval.kind !== 'UNKNOWN' && d.confirmed && !sameVector(d.confirmed.aspects, aspects)) {
    markUnknown(r);
    d.confirmed = { aspects, at: r.now, via: 'HEARTBEAT' };
    raiseFault(r, 'STATE_MISMATCH', undefined, 'Reported aspects differ from the confirmed state');
  }
}

function heartbeat(r: Run, m: HeartbeatMessage): Outcome {
  const { d } = r;
  const wasOffline = d.controller.link === 'OFFLINE';
  d.controller.link = 'ONLINE';
  d.controller.lastHeartbeatAt = r.now;
  if (!d.controller.commissioned) {
    d.controller.commissioned = true;
    r.log({ type: 'CONTROLLER_COMMISSIONED', severity: 'INFO' });
  }
  if (wasOffline) {
    clearFaults(r, ['CONTROLLER_OFFLINE']);
    d.controller.lastSafeStopAt = null;
    r.log({ type: 'CONTROLLER_ONLINE', severity: 'INFO' });
  }
  const p = d.pending;
  if (p && m.lastAppliedCommandId === p.commandId && !hasConflictingPermissive(r.cfg, m.aspects) && sameVector(m.aspects, p.target ?? allRed(r.cfg))) {
    r.log({ type: 'CONFIRMED_BY_HEARTBEAT', severity: 'INFO', correlationId: p.commandId });
    confirm(r, m.aspects, 'HEARTBEAT');
    return { ok: true, code: 'CONFIRMED' };
  }
  if (p) {
    if (hasConflictingPermissive(r.cfg, m.aspects)) observe(r, m.aspects);
    return { ok: true, code: 'OK' };
  }
  observe(r, m.aspects);
  return { ok: true, code: health(d) === 'FAILED' ? 'FAULT' : 'OK' };
}

function deviceStatus(r: Run, s: DeviceStatus): Outcome {
  const { d } = r;
  const down = s.status === 'OFFLINE' || s.status === 'FAULT';
  r.log({ type: 'DEVICE_STATUS_CHANGED', severity: down ? 'WARNING' : 'INFO', ...(s.direction ? { direction: s.direction } : {}), correlationId: s.eventId, details: { deviceType: s.deviceType, status: s.status } });
  if (s.deviceType === 'SENSOR') {
    if (!s.direction) return { ok: false, code: 'VALIDATION_FAILED', detail: 'Sensor status needs a direction' };
    if (down) raiseFault(r, 'SENSOR_OFFLINE', s.direction);
    else if (s.status === 'ONLINE') clearFaults(r, ['SENSOR_OFFLINE'], s.direction);
    return { ok: true, code: 'RECORDED' };
  }
  if (s.direction) {
    // A SIGNAL_CONTROLLER status naming a direction is read as a head fault (assumption A-03).
    if (down) { d.headStatus[s.direction] = 'OFFLINE'; raiseFault(r, 'SIGNAL_HEAD_FAULT', s.direction); }
    else if (s.status === 'ONLINE') d.headStatus[s.direction] = 'ONLINE';
    return { ok: true, code: 'RECORDED' };
  }
  if (down) goOffline(r);
  return { ok: true, code: 'RECORDED' };
}

function goOffline(r: Run) {
  const { d } = r;
  if (d.pending) {
    r.log({ type: 'COMMAND_ABANDONED', severity: 'WARNING', correlationId: d.pending.commandId, details: { reason: 'CONTROLLER_OFFLINE' } });
    d.pending = null;
  }
  d.controller.link = 'OFFLINE';
  markUnknown(r);
  raiseFault(r, 'CONTROLLER_OFFLINE');
  r.log({ type: 'CONTROLLER_OFFLINE', severity: 'WARNING' });
}

// ---------------------------------------------------------------- recovery

function recover(r: Run): Outcome {
  const { d } = r;
  r.log({ type: 'RECOVERY_STARTED', severity: 'INFO', details: { epoch: d.epoch, abandoned: d.pending?.commandId ?? null } });
  if (d.pending) {
    r.log({ type: 'COMMAND_ABANDONED', severity: 'WARNING', correlationId: d.pending.commandId, details: { reason: 'RESTART' } });
    d.pending = null;
  }
  markUnknown(r);
  d.faults = d.faults.filter((f) => !COMMS_FAULTS.includes(f.code) && f.code !== 'STATE_UNKNOWN');
  d.faults.push({ code: 'STATE_UNKNOWN', since: r.now });
  d.controller.link = 'UNKNOWN';
  d.controller.lastSafeStopAt = null;
  return { ok: true, code: 'RECOVERING' };
}

// ---------------------------------------------------------------- sensor events

function isNewer(ev: SensorEvent, sourceId: string, mark: { sourceId: string; seq: number; sensorTs: number }) {
  if (mark.sourceId === sourceId) return ev.sequenceNo > mark.seq;
  return ev.timestamp >= mark.sensorTs;
}

function findVehicle(d: JunctionState, vehicleId: string) {
  for (const [approach, list] of Object.entries(d.queues)) {
    const i = list.findIndex((v) => v.vehicleId === vehicleId);
    if (i >= 0) return { approach, index: i, vehicle: list[i]! };
  }
  return null;
}

function sensorEvent(r: Run, ev: SensorEvent, sourceId: string): Outcome {
  const { d, cfg, now } = r;
  if (!cfg.approaches.includes(ev.direction)) return { ok: false, code: 'UNKNOWN_DIRECTION' };
  if (ev.timestamp > now + 5 * 60_000) return { ok: false, code: 'TIMESTAMP_IN_FUTURE', detail: 'Sensor timestamp is more than 5 minutes ahead of server time' };
  if (ev.timestamp > now + 5_000) raiseFault(r, 'CLOCK_SKEW', sourceId);

  // Sequence tracking per source stream (plan §5.4). Never used for de-duplication.
  const stream = (d.sensors[sourceId] ??= { sourceId, approach: ev.direction, highWaterSeq: ev.sequenceNo - 1, lastSensorTs: ev.timestamp, recentGaps: [] });
  if (ev.sequenceNo < stream.highWaterSeq - 1000 && ev.timestamp > stream.lastSensorTs) {
    r.log({ type: 'SENSOR_SEQUENCE_RESET', severity: 'INFO', details: { sourceId, from: stream.highWaterSeq, to: ev.sequenceNo } });
    stream.highWaterSeq = ev.sequenceNo - 1;
  }
  if (ev.sequenceNo > stream.highWaterSeq + 1) {
    r.log({ type: 'SEQUENCE_GAP', severity: 'INFO', details: { sourceId, missing: ev.sequenceNo - stream.highWaterSeq - 1 } });
    stream.recentGaps = [...stream.recentGaps.filter((t) => now - t < 10 * 60_000), now];
    if (stream.recentGaps.length >= 3) raiseFault(r, 'SENSOR_SUSPECT', sourceId, 'repeated sequence gaps');
  }
  stream.highWaterSeq = Math.max(stream.highWaterSeq, ev.sequenceNo);
  stream.lastSensorTs = Math.max(stream.lastSensorTs, ev.timestamp);

  const mark = d.marks[ev.vehicleId];
  if (mark && !isNewer(ev, sourceId, mark)) {
    r.log({ type: 'SENSOR_EVENT_IGNORED', severity: 'INFO', direction: ev.direction, correlationId: ev.eventId, details: { reason: 'OUT_OF_ORDER', vehicleId: ev.vehicleId } });
    return { ok: true, code: 'IGNORED_OUT_OF_ORDER' };
  }
  const setMark = () => {
    d.marks[ev.vehicleId] = { eventType: ev.eventType, sourceId, seq: ev.sequenceNo, sensorTs: ev.timestamp, receivedAt: now };
  };

  if (ev.eventType === 'VEHICLE_CLEARED') {
    setMark();
    const found = findVehicle(d, ev.vehicleId);
    const em = d.emergencies.find((e) => e.vehicleId === ev.vehicleId);
    if (em) endEmergency(r, em, 'EMERGENCY_CLEARED');
    if (!found) {
      r.log({ type: 'SENSOR_EVENT_IGNORED', severity: 'INFO', direction: ev.direction, correlationId: ev.eventId, details: { reason: 'ORPHAN_CLEAR', vehicleId: ev.vehicleId } });
      return { ok: true, code: 'ORPHAN_CLEAR' };
    }
    d.queues[found.approach]!.splice(found.index, 1);
    r.log({ type: 'VEHICLE_CLEARED', severity: 'INFO', direction: found.approach, correlationId: ev.eventId, details: { vehicleId: ev.vehicleId } });
    const groups = cfg.raw.signalGroups.filter((g) => g.approach === found.approach).map((g) => g.id);
    if (d.confirmed && groups.every((g) => d.confirmed!.aspects[g] === 'RED')) {
      r.log({ type: 'VEHICLE_ANOMALY', severity: 'WARNING', direction: found.approach, correlationId: ev.eventId, details: { reason: 'CLEARED_ON_RED', vehicleId: ev.vehicleId } });
    }
    if (found.approach !== ev.direction) {
      r.log({ type: 'VEHICLE_ANOMALY', severity: 'WARNING', direction: ev.direction, details: { reason: 'CLEARED_OTHER_APPROACH', queuedAt: found.approach } });
      return { ok: true, code: 'CLEARED_OTHER_APPROACH' };
    }
    return { ok: true, code: em ? 'EMERGENCY_CLEARED' : 'CLEARED' };
  }

  // VEHICLE_ARRIVED
  const known = (VEHICLE_TYPES as readonly string[]).includes(ev.vehicleType ?? '');
  const type: VehicleType = known ? (ev.vehicleType as VehicleType) : 'UNKNOWN';
  if (!known) r.log({ type: 'DATA_QUALITY', severity: 'WARNING', direction: ev.direction, correlationId: ev.eventId, details: { reason: 'UNKNOWN_VEHICLE_TYPE', value: ev.vehicleType } });
  const age = now - ev.timestamp;
  if (age > cfg.ms.staleArrival) {
    r.log({ type: 'SENSOR_EVENT_IGNORED', severity: 'INFO', direction: ev.direction, correlationId: ev.eventId, details: { reason: 'STALE', ageMs: age } });
    return { ok: true, code: 'IGNORED_STALE', detail: `Sensor timestamp is ${Math.round(age / 1000)} s old` };
  }
  const existing = findVehicle(d, ev.vehicleId);
  if (existing && existing.approach === ev.direction) {
    setMark();
    if (type === 'EMERGENCY') return emergencyArrival(r, ev, sourceId, age);
    return { ok: true, code: 'ALREADY_QUEUED' };
  }
  const queue = d.queues[ev.direction]!;
  if (queue.length >= cfg.raw.queue.capacityPerApproach) {
    raiseFault(r, 'SENSOR_SUSPECT', sourceId, 'queue capacity exceeded');
    return { ok: false, code: 'QUEUE_CAPACITY_EXCEEDED' };
  }
  setMark();
  let code = 'QUEUED';
  if (existing) {
    d.queues[existing.approach]!.splice(existing.index, 1);
    r.log({ type: 'VEHICLE_ANOMALY', severity: 'WARNING', direction: ev.direction, details: { reason: 'MOVED', from: existing.approach } });
    code = 'MOVED';
  }
  queue.push({ vehicleId: ev.vehicleId, type, approach: ev.direction, queuedAt: now, sensorTs: ev.timestamp, sourceId, seq: ev.sequenceNo, eventId: ev.eventId });
  r.log({ type: 'VEHICLE_DETECTED', severity: 'INFO', direction: ev.direction, correlationId: ev.eventId, details: { vehicleId: ev.vehicleId, vehicleType: type } });
  if (type === 'EMERGENCY') return emergencyArrival(r, ev, sourceId, age);
  return { ok: true, code };
}

// ---------------------------------------------------------------- emergencies

function emergencyArrival(r: Run, ev: SensorEvent, sourceId: string, age: number): Outcome {
  const { d, cfg, now } = r;
  const active = d.emergencies.find((e) => e.vehicleId === ev.vehicleId);
  if (active) {
    active.lastSeenAt = now;
    active.expiresAt = Math.min(now + cfg.ms.emergencyHold, active.absoluteDeadline);
    r.log({ type: 'EMERGENCY_REFRESHED', severity: 'INFO', direction: ev.direction, correlationId: ev.eventId, details: { vehicleId: ev.vehicleId } });
    return { ok: true, code: 'EMERGENCY_REFRESHED' };
  }
  if (age > cfg.ms.staleEmergency) {
    r.log({ type: 'EMERGENCY_STALE_IGNORED', severity: 'WARNING', direction: ev.direction, correlationId: ev.eventId, details: { ageMs: age } });
    return { ok: true, code: 'QUEUED_NO_PREEMPTION' };
  }
  if ((d.cooldowns[ev.vehicleId] ?? 0) > now) {
    r.log({ type: 'EMERGENCY_COOLDOWN', severity: 'WARNING', direction: ev.direction, correlationId: ev.eventId });
    return { ok: true, code: 'QUEUED_NO_PREEMPTION' };
  }
  if (d.emergencies.length >= cfg.raw.emergency.maxActive) {
    r.log({ type: 'EMERGENCY_LIMIT_REACHED', severity: 'CRITICAL', direction: ev.direction, correlationId: ev.eventId });
    return { ok: true, code: 'QUEUED_NO_PREEMPTION' };
  }
  startEmergency(r, ev.vehicleId, ev.direction, 'SENSOR', sourceId, ev.eventId);
  return { ok: true, code: 'EMERGENCY_STARTED' };
}

function startEmergency(r: Run, vehicleId: string, approach: string, source: 'SENSOR' | 'OPERATOR', sourceId: string, correlationId: string) {
  const { d, cfg, now } = r;
  const phase = phaseOfApproach(cfg, approach)!;
  const e: Emergency = {
    id: r.ctx.newId('emg'), vehicleId, approach, phase, source, sourceId, detectedAt: now, lastSeenAt: now,
    expiresAt: now + cfg.ms.emergencyHold, absoluteDeadline: now + cfg.ms.emergencyCap,
    servedSince: d.interval.kind === 'GREEN' && d.interval.phase === phase ? now : null,
  };
  d.emergencies.push(e);
  r.log({ type: 'EMERGENCY_DETECTED', severity: 'WARNING', direction: approach, correlationId, details: { vehicleId, phase, source } });
  const h = health(d);
  if (h === 'FAILED' || h === 'UNKNOWN') r.log({ type: 'PREEMPTION_UNAVAILABLE', severity: 'CRITICAL', direction: approach, details: { health: h } });
  if (d.hold) r.log({ type: 'EMERGENCY_BLOCKED_BY_HOLD', severity: 'CRITICAL', direction: approach });
  if (d.emergencies.some((x) => x.phase !== phase)) r.log({ type: 'EMERGENCY_CONFLICT', severity: 'CRITICAL', details: { phases: [...new Set(d.emergencies.map((x) => x.phase))] } });
}

function endEmergency(r: Run, e: Emergency, type: 'EMERGENCY_CLEARED' | 'EMERGENCY_TIMEOUT' | 'EMERGENCY_CANCELLED') {
  r.d.emergencies = r.d.emergencies.filter((x) => x !== e);
  r.log({ type, severity: type === 'EMERGENCY_TIMEOUT' ? 'WARNING' : 'INFO', direction: e.approach, details: { vehicleId: e.vehicleId } });
}

// ---------------------------------------------------------------- operator commands

function operatorCommand(r: Run, c: OperatorCommand, actor: string, requestId: string): Outcome {
  const { d, cfg, now } = r;
  const h = health(d);
  const reject = (code: string, detail?: string): Outcome => {
    r.log({ type: 'OPERATOR_COMMAND_REJECTED', severity: 'INFO', correlationId: requestId, details: { command: c.command, code, actor } });
    return { ok: false, code, ...(detail ? { detail } : {}) };
  };
  const accept = (data: Record<string, unknown> = {}): Outcome => {
    r.log({ type: 'OPERATOR_COMMAND_ACCEPTED', severity: 'INFO', correlationId: requestId, details: { command: c.command, actor, ...('reason' in c ? { reason: c.reason } : {}) } });
    return { ok: true, code: 'ACCEPTED', data };
  };
  switch (c.command) {
    case 'MANUAL_GREEN_REQUEST': {
      const phase = cfg.approaches.includes(c.direction) ? phaseOfApproach(cfg, c.direction) : null;
      if (!phase) return reject('UNKNOWN_DIRECTION');
      if (h === 'FAILED' || h === 'UNKNOWN') return reject('CONTROLLER_UNAVAILABLE', 'The junction cannot accept greens until the controller state is confirmed safe');
      if (d.emergencies.length > 0) return reject('EMERGENCY_ACTIVE', 'Manual control is unavailable while an emergency vehicle is being served');
      if (d.hold) return reject('HOLD_ACTIVE', 'Release the all-red hold first');
      const retarget = d.manual !== null && d.manual.leaseExpiresAt > now;
      d.manual = { requestId, phase, by: actor, reason: c.reason, startedAt: retarget ? d.manual!.startedAt : now, leaseExpiresAt: now + cfg.ms.lease };
      r.log({ type: retarget ? 'MANUAL_OVERRIDE_RETARGETED' : 'MANUAL_OVERRIDE_STARTED', severity: 'INFO', direction: c.direction, correlationId: requestId, details: { phase, actor, reason: c.reason } });
      return accept({ target_phase: phase, lease_expires_at: d.manual.leaseExpiresAt });
    }
    case 'RETURN_TO_AUTOMATIC':
      if (d.manual) {
        d.manual = null;
        r.log({ type: 'RETURNED_TO_AUTOMATIC', severity: 'INFO', correlationId: requestId, details: { actor } });
      }
      return accept();
    case 'EXTEND_MANUAL': {
      if (!d.manual || d.manual.leaseExpiresAt <= now) return reject('NOT_IN_MANUAL');
      const cap = d.manual.startedAt + cfg.ms.maxLease;
      if (d.manual.leaseExpiresAt >= cap) return reject('LEASE_LIMIT_REACHED');
      d.manual.leaseExpiresAt = Math.min(d.manual.leaseExpiresAt + cfg.ms.lease, cap);
      r.log({ type: 'MANUAL_LEASE_EXTENDED', severity: 'INFO', correlationId: requestId, details: { until: d.manual.leaseExpiresAt } });
      return accept({ lease_expires_at: d.manual.leaseExpiresAt });
    }
    case 'ALL_RED_HOLD':
      if (!d.hold) {
        d.hold = { by: actor, reason: c.reason, since: now, requestId };
        r.log({ type: 'HOLD_STARTED', severity: 'WARNING', correlationId: requestId, details: { actor, reason: c.reason } });
        if (d.emergencies.length > 0) r.log({ type: 'EMERGENCY_BLOCKED_BY_HOLD', severity: 'CRITICAL' });
      }
      return accept();
    case 'RELEASE_HOLD':
      if (d.hold) {
        d.hold = null;
        r.log({ type: 'HOLD_RELEASED', severity: 'INFO', correlationId: requestId, details: { actor } });
      }
      return accept();
    case 'EMERGENCY_PREEMPT': {
      if (!cfg.approaches.includes(c.direction)) return reject('UNKNOWN_DIRECTION');
      if (h === 'FAILED' || h === 'UNKNOWN') {
        r.log({ type: 'PREEMPTION_UNAVAILABLE', severity: 'CRITICAL', direction: c.direction });
        return reject('CONTROLLER_UNAVAILABLE');
      }
      startEmergency(r, `operator:${requestId}`, c.direction, 'OPERATOR', actor, requestId);
      return accept();
    }
    case 'EMERGENCY_CANCEL': {
      const victims = d.emergencies.filter((e) => !c.vehicleId || e.vehicleId === c.vehicleId);
      for (const e of victims) {
        endEmergency(r, e, 'EMERGENCY_CANCELLED');
        d.cooldowns[e.vehicleId] = now + cfg.ms.cancelCooldown;
      }
      return accept({ cancelled: victims.length });
    }
    case 'RESUME_AFTER_FAULT': {
      const unmet: string[] = [];
      if (d.controller.link !== 'ONLINE') unmet.push('controller is not online');
      const badHeads = Object.entries(d.headStatus).filter(([, v]) => v !== 'ONLINE').map(([k]) => k);
      if (badHeads.length) unmet.push(`signal heads not online: ${badHeads.join(', ')}`);
      if (unmet.length) return reject('RESUME_PRECONDITIONS_NOT_MET', unmet.join('; '));
      clearFaults(r, OPERATOR_RESUME_FAULTS);
      r.log({ type: 'RESUMED_AFTER_FAULT', severity: 'WARNING', correlationId: requestId, details: { actor, reason: c.reason } });
      d.controller.lastSafeStopAt = null;
      if (d.interval.kind !== 'ALL_RED') markUnknown(r);
      return accept();
    }
  }
}

// ---------------------------------------------------------------- deadlines

function housekeeping(r: Run) {
  const { d, cfg, now } = r;
  // ACK deadline: retry with the same command_id, then give up (plan §8.3, T-9/T-10).
  const p = d.pending;
  if (p) {
    if (now >= p.ackDeadline) {
      if (p.attempt <= cfg.raw.controller.maxRetries) {
        p.attempt += 1;
        p.ackDeadline = now + cfg.ms.ackTimeout;
        p.expiresAt = now + (p.kind === 'SAFE_STOP' ? cfg.ms.safeStopTtl : cfg.ms.commandTtl);
        r.effects.push({ type: 'SEND_COMMAND', command: { ...p }, junctionId: d.junctionId });
        r.log({ type: 'CONTROLLER_RETRY', severity: 'WARNING', correlationId: p.commandId, details: { attempt: p.attempt } });
        r.wake(p.ackDeadline);
      } else {
        r.log({ type: 'CONTROLLER_TIMEOUT', severity: 'WARNING', correlationId: p.commandId, details: { step: p.step } });
        d.pending = null;
        markUnknown(r);
        raiseFault(r, 'CONTROLLER_UNRESPONSIVE', undefined, `no ACK for ${p.step}`, p.kind !== 'SAFE_STOP');
      }
    } else {
      r.wake(p.ackDeadline);
    }
  }
  // Heartbeat watchdog.
  const c = d.controller;
  if (c.commissioned && c.link === 'ONLINE' && c.lastHeartbeatAt !== null) {
    const deadline = c.lastHeartbeatAt + cfg.ms.heartbeatTimeout;
    if (now >= deadline) goOffline(r);
    else r.wake(deadline);
  }
  // Manual lease.
  if (d.manual) {
    if (now >= d.manual.leaseExpiresAt) {
      r.log({ type: 'MANUAL_LEASE_EXPIRED', severity: 'INFO', correlationId: d.manual.requestId });
      d.manual = null;
    } else r.wake(d.manual.leaseExpiresAt);
  }
  // Emergency expiry.
  // oxlint-disable-next-line unicorn/no-useless-spread -- endEmergency removes entries while we iterate
  for (const e of [...d.emergencies]) {
    if (now >= e.expiresAt) endEmergency(r, e, 'EMERGENCY_TIMEOUT');
    else r.wake(e.expiresAt);
  }
  // Phantom vehicles and tombstones.
  for (const [approach, list] of Object.entries(d.queues)) {
    const keep = list.filter((v) => now - v.queuedAt < cfg.ms.entryTtl);
    for (const v of list.filter((x) => !keep.includes(x))) {
      r.log({ type: 'QUEUE_ENTRY_EXPIRED', severity: 'WARNING', direction: approach, details: { vehicleId: v.vehicleId } });
    }
    d.queues[approach] = keep;
    const oldest = keep[0];
    if (oldest) r.wake(oldest.queuedAt + cfg.ms.entryTtl);
  }
  for (const [vid, m] of Object.entries(d.marks)) {
    const queued = findVehicle(d, vid) !== null;
    if (!queued && now - m.receivedAt > cfg.ms.tombstoneTtl) delete d.marks[vid];
  }
  for (const [vid, until] of Object.entries(d.cooldowns)) if (until <= now) delete d.cooldowns[vid];
}

// ---------------------------------------------------------------- drive: what the signals do next

function drive(r: Run) {
  const { d, cfg, now } = r;
  if (d.pending) return;
  const h = health(d);
  const reachable = d.controller.commissioned && d.controller.link !== 'OFFLINE';

  if (d.interval.kind === 'UNKNOWN' || (h === 'FAILED' && d.interval.kind !== 'ALL_RED')) {
    if (!reachable) return;
    const last = d.controller.lastSafeStopAt;
    if (last !== null && now - last < cfg.ms.safeStopRetryGap) { r.wake(last + cfg.ms.safeStopRetryGap); return; }
    send(r, 'SAFE_STOP', null, h === 'FAILED' ? 'FAULT' : 'RECOVERY');
    return;
  }
  if (h === 'FAILED' || h === 'UNKNOWN') return;

  const iv = d.interval;
  if (iv.kind === 'YELLOW') {
    if (now - iv.since >= cfg.ms.yellow) send(r, 'ALL_RED', iv.phase, 'SCHEDULER');
    else r.wake(iv.since + cfg.ms.yellow);
    return;
  }
  if (iv.kind === 'ALL_RED') {
    if (d.hold) return;
    if (now - iv.since < cfg.ms.allRed) { r.wake(iv.since + cfg.ms.allRed); return; }
    const choice = chooseTarget(r);
    r.log({ type: 'PHASE_DECISION', severity: 'INFO', details: { rule: choice.rule, chosen: choice.phase, current: null, scores: choice.scores } });
    send(r, 'GREEN', choice.phase, choice.cause);
    return;
  }
  if (iv.kind === 'GREEN') driveGreen(r, iv);
}

function chooseTarget(r: Run): { phase: string; rule: string; cause: CommandCause; scores?: unknown } {
  const { d, cfg, now } = r;
  const head = d.emergencies[0];
  if (head) return { phase: head.phase, rule: 'EMERGENCY', cause: 'EMERGENCY' };
  if (d.manual && d.manual.leaseExpiresAt > now) return { phase: d.manual.phase, rule: 'MANUAL', cause: 'MANUAL' };
  const c = chooseFromAllRed(cfg, d, now);
  return { phase: c.phase, rule: c.rule, cause: 'SCHEDULER', scores: c.scores };
}

function driveGreen(r: Run, iv: Extract<JunctionState['interval'], { kind: 'GREEN' }>) {
  const { d, cfg, now } = r;
  const p = iv.phase;
  const elapsed = now - iv.since;
  const leave = (rule: string, cause: CommandCause, scores?: unknown) => {
    r.log({ type: 'PHASE_DECISION', severity: 'INFO', details: { rule, current: p, decision: 'LEAVE', scores } });
    r.log({ type: 'SIGNAL_TRANSITION_STARTED', severity: 'INFO', details: { from: p, rule } });
    send(r, 'YELLOW', p, cause);
  };

  if (d.hold) return leave('HOLD', 'HOLD');
  const head = d.emergencies[0];
  if (head) {
    if (head.phase !== p) return leave('EMERGENCY', 'EMERGENCY');
    if (d.emergencies.some((e) => e.phase !== p)) {
      const served = head.servedSince ?? iv.since;
      if (now - served >= cfg.ms.contestedSlice) {
        const servedGroup = d.emergencies.filter((e) => e.phase === p);
        d.emergencies = [...d.emergencies.filter((e) => e.phase !== p), ...servedGroup.map((e) => ({ ...e, servedSince: null }))];
        r.log({ type: 'EMERGENCY_ROTATED', severity: 'WARNING', details: { from: p, to: d.emergencies[0]!.phase } });
        return leave('EMERGENCY', 'EMERGENCY');
      }
      r.wake(served + cfg.ms.contestedSlice);
    }
    return;
  }
  if (d.manual && d.manual.leaseExpiresAt > now) {
    if (d.manual.phase === p) return;
    if (elapsed >= cfg.ms.minGreen) return leave('MANUAL', 'MANUAL');
    r.wake(iv.since + cfg.ms.minGreen);
    return;
  }

  const scores = scorePhases(cfg, d, now);
  const cur = scores.find((s) => s.phase === p)!;
  const others = scores.filter((s) => s.phase !== p && s.demand > 0);
  if (others.length === 0) return; // rest in green
  if (elapsed < cfg.ms.minGreen) { r.wake(iv.since + cfg.ms.minGreen); return; }
  if (others.some((s) => s.oldestWaitMs >= cfg.ms.starvation)) return leave('STARVATION', 'SCHEDULER', scores);
  if (elapsed >= cfg.ms.maxGreen) return leave('MAX_GREEN', 'SCHEDULER', scores);
  if (cur.demand === 0) return leave('GAP_OUT', 'SCHEDULER', scores);
  const blocks = Math.floor(elapsed / cfg.ms.greenBlock);
  if (blocks > iv.blocksEvaluated) {
    iv.blocksEvaluated = blocks;
    const best = others.reduce((a, b) => (b.score > a.score ? b : a));
    if (best.score > cfg.raw.scheduling.hysteresis * cur.score) return leave('SCORE', 'SCHEDULER', scores);
    r.log({ type: 'PHASE_DECISION', severity: 'INFO', details: { rule: 'SCORE', current: p, decision: 'STAY', scores } });
  }
  const nextBlock = iv.since + (iv.blocksEvaluated + 1) * cfg.ms.greenBlock;
  const starveAt = Math.min(...others.map((s) => now + (cfg.ms.starvation - s.oldestWaitMs)));
  r.wake(Math.min(nextBlock, iv.since + cfg.ms.maxGreen, starveAt));
}
