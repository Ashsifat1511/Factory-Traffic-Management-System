import { describe, expect, it } from 'vitest';
import { A_JSON, Harness, loadA, runningJunction, types } from './harness.js';
import {
  allowedCommands, assertSafeCommand, chooseFromAllRed, compileConfig, configFromJson, health, initialState, scorePhases,
  UnsafeCommand, validateConfig, type AckMessage, type AspectVector, type DeviceStatus,
} from '../src/index.js';

/** Rule-level tests for plan §16.2 rows not exercised by the scenario tests in domain.test.ts. */

const phaseOf = (h: Harness) => (h.state.interval as { phase: string }).phase;
const otherDir = (h: Harness) => (phaseOf(h) === 'NORTH_SOUTH' ? 'EAST' : 'NORTH');
const ownDir = (h: Harness) => (phaseOf(h) === 'NORTH_SOUTH' ? 'NORTH' : 'EAST');
const codes = (h: Harness) => h.state.faults.map((f) => f.code);
const msg = (h: Harness, m: AckMessage | { type: 'HEARTBEAT'; aspects: AspectVector; lastAppliedCommandId: string | null }) =>
  h.input({ kind: 'CONTROLLER_MESSAGE', message: m });
const ackPending = (h: Harness, status: AckMessage['status'], extra: Partial<AckMessage> = {}) =>
  msg(h, { type: 'ACK', commandId: h.state.pending!.commandId, status, ...extra });
const device = (h: Harness, s: Partial<DeviceStatus>) =>
  h.input({ kind: 'DEVICE_STATUS', sourceId: 'ctrl', status: { eventId: `ds-${h.now}-${Math.round(h.now % 997)}`, junctionId: 'A', deviceType: 'SIGNAL_CONTROLLER', status: 'ONLINE', timestamp: h.now, ...s } });
const v = (n: string, s: string, e: string, w: string) => ({ NORTH: n, SOUTH: s, EAST: e, WEST: w }) as AspectVector;
const NS_GREEN = v('GREEN', 'GREEN', 'RED', 'RED');
const ALL_RED = v('RED', 'RED', 'RED', 'RED');

/** A running junction whose controller stops answering, so the test can play the controller's replies itself. */
function manualController(): Harness {
  const h = runningJunction();
  h.ctrl.faults.dropAcks = true;
  h.heartbeats = false;
  return h;
}

describe('controller messages (plan §8.3)', () => {
  it('confirms an ACK given in shorthand (actual_state)', () => {
    const h = manualController();
    h.command({ command: 'ALL_RED_HOLD', reason: 't' });
    expect(ackPending(h, 'ACK', { actualState: 'YELLOW' }).code).toBe('CONFIRMED');
    expect(h.state.interval.kind).toBe('YELLOW');
  });

  it('treats a shorthand ACK for the wrong state as a mismatch', () => {
    const h = manualController();
    h.command({ command: 'ALL_RED_HOLD', reason: 't' });
    expect(ackPending(h, 'ACK', { actualState: 'GREEN' }).code).toBe('STATE_MISMATCH');
    expect(health(h.state)).toBe('FAILED');
    expect(allowedCommands(h.state, h.now)).toContain('RESUME_AFTER_FAULT');
  });

  it('a NACK leaves the state unknown and needs an operator resume', () => {
    const h = manualController();
    h.command({ command: 'ALL_RED_HOLD', reason: 't' });
    expect(ackPending(h, 'NACK', { reason: 'HARDWARE_FAULT', actualAspects: h.physicalAspects() }).code).toBe('COMMAND_REJECTED');
    expect(codes(h)).toContain('COMMAND_REJECTED');
    expect(h.state.interval.kind).toBe('UNKNOWN');
  });

  it('an ACK reporting conflicting greens raises UNSAFE_STATE_REPORTED', () => {
    const h = manualController();
    h.command({ command: 'ALL_RED_HOLD', reason: 't' });
    expect(ackPending(h, 'ACK', { actualAspects: v('GREEN', 'GREEN', 'GREEN', 'RED') }).code).toBe('UNSAFE_STATE_REPORTED');
    expect(types(h)).toContain('FAULT_RAISED');
    expect(h.audit.find((a) => a.type === 'FAULT_RAISED' && (a.details as { code: string }).code === 'UNSAFE_STATE_REPORTED')!.severity).toBe('CRITICAL');
  });

  it('duplicate, late and unknown ACKs never change the confirmed state', () => {
    const h = manualController();
    h.command({ command: 'ALL_RED_HOLD', reason: 't' });
    const id = h.state.pending!.commandId;
    h.advance(50); // the controller applies the command; its ACK is dropped
    expect(ackPending(h, 'ACK', { actualAspects: h.physicalAspects() }).code).toBe('CONFIRMED');
    expect(msg(h, { type: 'ACK', commandId: id, status: 'ACK' }).code).toBe('DUPLICATE_ACK');
    expect(msg(h, { type: 'ACK', commandId: 'cmd-unknown', status: 'ACK' }).code).toBe('LATE_OR_UNKNOWN_ACK');
    expect(h.state.interval.kind).toBe('YELLOW');
    // A late ACK that reports conflicting greens is still checked for safety.
    msg(h, { type: 'ACK', commandId: 'cmd-old', status: 'ACK', actualAspects: v('GREEN', 'RED', 'GREEN', 'RED') });
    expect(codes(h)).toContain('UNSAFE_STATE_REPORTED');
  });

  it('a heartbeat that disagrees with the confirmed state raises STATE_MISMATCH', () => {
    const h = runningJunction();
    h.heartbeats = false;
    const wrong = phaseOf(h) === 'NORTH_SOUTH' ? v('RED', 'RED', 'GREEN', 'GREEN') : NS_GREEN;
    msg(h, { type: 'HEARTBEAT', aspects: wrong, lastAppliedCommandId: null });
    expect(codes(h)).toContain('STATE_MISMATCH');
    expect(h.state.interval.kind).toBe('UNKNOWN');
  });

  it('a heartbeat with conflicting greens while a command is pending is unsafe', () => {
    const h = manualController();
    h.command({ command: 'ALL_RED_HOLD', reason: 't' });
    msg(h, { type: 'HEARTBEAT', aspects: v('GREEN', 'RED', 'GREEN', 'RED'), lastAppliedCommandId: null });
    expect(codes(h)).toContain('UNSAFE_STATE_REPORTED');
    expect(h.state.pending?.kind).toBe('SAFE_STOP'); // the YELLOW is dropped; the junction is driven to a safe stop
  });

  it('ignores a timer whose token is stale', () => {
    const h = runningJunction();
    expect(h.input({ kind: 'WAKE', token: -1 }).code).toBe('STALE_TIMER');
  });

  it('waits the retry gap between SAFE_STOP attempts', () => {
    const h = runningJunction();
    h.ctrl.faults.dropAcks = true;
    h.heartbeats = false;
    h.input({ kind: 'RECOVER' });
    h.input({ kind: 'CONTROLLER_MESSAGE', message: { type: 'HEARTBEAT', aspects: h.physicalAspects(), lastAppliedCommandId: null } });
    h.advance(7_000); // SAFE_STOP sent, retried, timed out
    expect(types(h)).toContain('CONTROLLER_TIMEOUT');
    const sent = types(h).filter((t) => t === 'SIGNAL_STATE_REQUESTED').length;
    h.input({ kind: 'CONTROLLER_MESSAGE', message: { type: 'HEARTBEAT', aspects: h.physicalAspects(), lastAppliedCommandId: null } });
    expect(types(h).filter((t) => t === 'SIGNAL_STATE_REQUESTED').length).toBe(sent); // still inside the retry gap
  });

  it('the safety guard trips instead of sending an unsafe command', () => {
    const h = runningJunction();
    h.heartbeats = false;
    // Corrupt the believed state: all-red interval while the confirmed aspects still show a green.
    h.state = { ...h.state, interval: { kind: 'ALL_RED', since: h.now - 60_000, lastPhase: null }, confirmed: { aspects: NS_GREEN, at: h.now, via: 'ACK' }, allRedConfirmedAt: h.now - 60_000, pending: null };
    h.sensor('EAST', 'VEHICLE_ARRIVED', 'T', 'TRUCK');
    expect(types(h)).toContain('SAFETY_GUARD_TRIPPED');
    expect(health(h.state)).toBe('FAILED');
  });
});

describe('device status (plan §8.4)', () => {
  it('validates sensor status, raises and clears SENSOR_OFFLINE and recalls the approach', () => {
    const h = runningJunction();
    expect(device(h, { deviceType: 'SENSOR' }).code).toBe('VALIDATION_FAILED');
    device(h, { deviceType: 'SENSOR', direction: 'EAST', status: 'OFFLINE' });
    expect(codes(h)).toContain('SENSOR_OFFLINE');
    expect(health(h.state)).toBe('DEGRADED');
    const ew = scorePhases(h.cfg, h.state, h.now).find((s) => s.phase === 'EAST_WEST')!;
    expect(ew.demand).toBe(1); // recall
    device(h, { deviceType: 'SENSOR', direction: 'EAST', status: 'ONLINE' });
    expect(codes(h)).not.toContain('SENSOR_OFFLINE');
  });

  it('a signal head fault blocks resume until the head is back online', () => {
    const h = runningJunction();
    device(h, { direction: 'WEST', status: 'FAULT' });
    expect(codes(h)).toContain('SIGNAL_HEAD_FAULT');
    expect(h.command({ command: 'RESUME_AFTER_FAULT', reason: 'r' }).code).toBe('RESUME_PRECONDITIONS_NOT_MET');
    device(h, { direction: 'WEST', status: 'ONLINE' });
    expect(h.command({ command: 'RESUME_AFTER_FAULT', reason: 'r' }).code).toBe('ACCEPTED');
    h.advance(20_000);
    expect(health(h.state)).toBe('OK');
    expect(h.violations).toEqual([]);
  });

  it('a controller OFFLINE status (MQTT last will) abandons the pending command at once', () => {
    const h = manualController();
    h.command({ command: 'ALL_RED_HOLD', reason: 't' });
    device(h, { status: 'OFFLINE' });
    expect(codes(h)).toContain('CONTROLLER_OFFLINE');
    expect(types(h)).toContain('COMMAND_ABANDONED');
    expect(h.state.pending).toBeNull();
  });

  it('recovery abandons a pending command', () => {
    const h = manualController();
    h.command({ command: 'ALL_RED_HOLD', reason: 't' });
    h.input({ kind: 'RECOVER' });
    expect(h.audit.some((a) => a.type === 'COMMAND_ABANDONED' && (a.details as { reason: string }).reason === 'RESTART')).toBe(true);
  });
});

describe('sensor event rules (plan §5.4, §5.5)', () => {
  it('rejects unknown directions and flags clock skew', () => {
    const h = runningJunction();
    expect(h.sensor('UP', 'VEHICLE_ARRIVED', 'x').code).toBe('UNKNOWN_DIRECTION');
    h.sensor('NORTH', 'VEHICLE_ARRIVED', 'sk', 'TRUCK', { ts: h.now + 10_000 });
    expect(codes(h)).toContain('CLOCK_SKEW');
  });

  it('detects a sequence reset and repeated gaps', () => {
    const h = runningJunction();
    h.sensor('SOUTH', 'VEHICLE_ARRIVED', 'a', 'TRUCK', { source: 'sx', seq: 5000 });
    h.sensor('SOUTH', 'VEHICLE_ARRIVED', 'b', 'TRUCK', { source: 'sx', seq: 3, ts: h.now + 1 });
    expect(types(h)).toContain('SENSOR_SEQUENCE_RESET');
    for (const seq of [10, 20, 30]) h.sensor('SOUTH', 'VEHICLE_ARRIVED', `g${seq}`, 'TRUCK', { source: 'sx', seq });
    expect(codes(h)).toContain('SENSOR_SUSPECT');
  });

  it('enforces the queue capacity', () => {
    const h = runningJunction();
    for (let i = 0; i < 100; i++) h.sensor('WEST', 'VEHICLE_ARRIVED', `c${i}`, 'EMPLOYEE_VEHICLE', { source: 'cap', seq: i + 1 });
    expect(h.sensor('WEST', 'VEHICLE_ARRIVED', 'c100', 'EMPLOYEE_VEHICLE', { source: 'cap', seq: 101 }).code).toBe('QUEUE_CAPACITY_EXCEEDED');
    expect(h.state.queues.WEST).toHaveLength(100);
  });

  it('handles re-arrival, moved vehicles, clears from another approach and clears on red', () => {
    const h = runningJunction();
    const red = otherDir(h);
    expect(h.sensor(red, 'VEHICLE_ARRIVED', 'm1', 'TRUCK').code).toBe('QUEUED');
    expect(h.sensor(red, 'VEHICLE_ARRIVED', 'm1', 'TRUCK').code).toBe('ALREADY_QUEUED');
    expect(h.sensor('SOUTH', 'VEHICLE_ARRIVED', 'm1', 'TRUCK').code).toBe('MOVED');
    expect(h.sensor('WEST', 'VEHICLE_CLEARED', 'm1').code).toBe('CLEARED_OTHER_APPROACH');
    h.sensor(red, 'VEHICLE_ARRIVED', 'm2', 'TRUCK');
    h.sensor(red, 'VEHICLE_CLEARED', 'm2');
    expect(h.audit.some((a) => a.type === 'VEHICLE_ANOMALY' && (a.details as { reason: string }).reason === 'CLEARED_ON_RED')).toBe(true);
  });

  it('expires phantom vehicles after the entry TTL', () => {
    const h = runningJunction();
    h.command({ command: 'ALL_RED_HOLD', reason: 'keep the queue' });
    h.sensor('EAST', 'VEHICLE_ARRIVED', 'ghost', 'TRUCK');
    h.advance(601_000);
    expect(types(h)).toContain('QUEUE_ENTRY_EXPIRED');
    expect(h.state.queues.EAST).toHaveLength(0);
  });
});

describe('emergencies (plan §6)', () => {
  it('refreshes instead of duplicating, ignores stale ones and respects cooldown and the limit', () => {
    const h = runningJunction();
    const dir = otherDir(h);
    h.sensor(dir, 'VEHICLE_ARRIVED', 'EV', 'EMERGENCY');
    expect(h.sensor(dir, 'VEHICLE_ARRIVED', 'EV', 'EMERGENCY').code).toBe('EMERGENCY_REFRESHED');
    expect(h.state.emergencies).toHaveLength(1);
    expect(h.sensor(dir, 'VEHICLE_ARRIVED', 'OLD', 'EMERGENCY', { ts: h.now - 40_000 }).code).toBe('QUEUED_NO_PREEMPTION');
    expect(h.command({ command: 'EMERGENCY_CANCEL', vehicleId: 'EV', reason: 'false alarm' }).code).toBe('ACCEPTED');
    expect(h.state.emergencies).toHaveLength(0);
    expect(h.sensor(dir, 'VEHICLE_ARRIVED', 'EV', 'EMERGENCY').code).toBe('QUEUED_NO_PREEMPTION'); // cooldown
    for (const id of ['E1', 'E2', 'E3', 'E4']) h.sensor(dir, 'VEHICLE_ARRIVED', id, 'EMERGENCY');
    expect(h.sensor(dir, 'VEHICLE_ARRIVED', 'E5', 'EMERGENCY').code).toBe('QUEUED_NO_PREEMPTION');
    expect(types(h)).toContain('EMERGENCY_LIMIT_REACHED');
  });

  it('times out an emergency that never clears', () => {
    const h = runningJunction();
    h.sensor(otherDir(h), 'VEHICLE_ARRIVED', 'EV', 'EMERGENCY');
    h.advance(121_000);
    expect(types(h)).toContain('EMERGENCY_TIMEOUT');
    expect(h.state.emergencies).toHaveLength(0);
    expect(h.violations).toEqual([]);
  });

  it('rotates conflicting emergencies after the contested slice, safely', () => {
    const h = runningJunction();
    h.sensor('NORTH', 'VEHICLE_ARRIVED', 'EV-N', 'EMERGENCY');
    h.sensor('EAST', 'VEHICLE_ARRIVED', 'EV-E', 'EMERGENCY');
    expect(types(h)).toContain('EMERGENCY_CONFLICT');
    h.advance(80_000);
    expect(types(h)).toContain('EMERGENCY_ROTATED');
    expect(h.violations).toEqual([]);
  });

  it('reports when preemption is blocked by a hold or unavailable while FAILED', () => {
    const h = runningJunction();
    h.command({ command: 'ALL_RED_HOLD', reason: 'inspection' });
    h.sensor('EAST', 'VEHICLE_ARRIVED', 'EV-H', 'EMERGENCY');
    expect(types(h)).toContain('EMERGENCY_BLOCKED_BY_HOLD');

    const f = runningJunction();
    f.ctrl.faults.offline = true;
    f.advance(20_000);
    f.sensor('EAST', 'VEHICLE_ARRIVED', 'EV-F', 'EMERGENCY');
    expect(types(f)).toContain('PREEMPTION_UNAVAILABLE');
    expect(f.command({ command: 'EMERGENCY_PREEMPT', direction: 'EAST', reason: 'r' }).code).toBe('CONTROLLER_UNAVAILABLE');
  });

  it('an operator preemption behaves like a sensor emergency', () => {
    const h = runningJunction();
    expect(h.command({ command: 'EMERGENCY_PREEMPT', direction: 'UP', reason: 'r' }).code).toBe('UNKNOWN_DIRECTION');
    expect(h.command({ command: 'EMERGENCY_PREEMPT', direction: otherDir(h), reason: 'fire drill' }).code).toBe('ACCEPTED');
    expect(h.state.emergencies[0]!.source).toBe('OPERATOR');
    h.advance(12_000);
    expect(h.state.interval.kind).toBe('GREEN');
    expect(h.command({ command: 'EMERGENCY_CANCEL', reason: 'done' }).code).toBe('ACCEPTED');
    expect(h.violations).toEqual([]);
  });
});

describe('operator commands (plan §7)', () => {
  it('rejects manual requests for unknown directions, while FAILED and during a hold', () => {
    const h = runningJunction();
    expect(h.command({ command: 'MANUAL_GREEN_REQUEST', direction: 'UP', reason: 'r' }).code).toBe('UNKNOWN_DIRECTION');
    h.command({ command: 'ALL_RED_HOLD', reason: 'r' });
    expect(h.command({ command: 'MANUAL_GREEN_REQUEST', direction: 'WEST', reason: 'r' }).code).toBe('HOLD_ACTIVE');
    expect(allowedCommands(h.state, h.now)).toContain('RELEASE_HOLD');
    h.command({ command: 'RELEASE_HOLD' });

    const f = runningJunction();
    f.ctrl.faults.offline = true;
    f.advance(20_000);
    expect(f.command({ command: 'MANUAL_GREEN_REQUEST', direction: 'WEST', reason: 'r' }).code).toBe('CONTROLLER_UNAVAILABLE');
    expect(allowedCommands(f.state, f.now)).not.toContain('MANUAL_GREEN_REQUEST');
  });

  it('retargets, extends up to the cap and expires the manual lease', () => {
    const h = runningJunction();
    expect(h.command({ command: 'EXTEND_MANUAL' }).code).toBe('NOT_IN_MANUAL');
    h.command({ command: 'MANUAL_GREEN_REQUEST', direction: otherDir(h), reason: 'a' });
    h.advance(1_000);
    h.command({ command: 'MANUAL_GREEN_REQUEST', direction: ownDir(h), reason: 'b' });
    expect(types(h)).toContain('MANUAL_OVERRIDE_RETARGETED');
    expect(allowedCommands(h.state, h.now)).toEqual(expect.arrayContaining(['RETURN_TO_AUTOMATIC', 'EXTEND_MANUAL']));
    const outs = Array.from({ length: 6 }, () => h.command({ command: 'EXTEND_MANUAL' }).code);
    expect(outs.slice(0, 5).every((c) => c === 'ACCEPTED')).toBe(true);
    expect(outs[5]).toBe('LEASE_LIMIT_REACHED');
    h.advance(3_601_000);
    expect(types(h)).toContain('MANUAL_LEASE_EXPIRED');
    expect(h.state.manual).toBeNull();
    expect(h.violations).toEqual([]);
  });
});

describe('scheduler (plan §4)', () => {
  const cfg = loadA();
  const vehicle = (id: string, approach: string, queuedAt: number, type: 'TRUCK' | 'EMPLOYEE_VEHICLE' = 'EMPLOYEE_VEHICLE') =>
    ({ vehicleId: id, type, approach, queuedAt, sensorTs: queuedAt, sourceId: 's', seq: 1, eventId: id });

  it('rests on the least recently served phase without demand', () => {
    const s = initialState(cfg, 0);
    s.lastServedAt = { NORTH_SOUTH: 5_000, EAST_WEST: 1_000 };
    expect(chooseFromAllRed(cfg, s, 10_000)).toMatchObject({ phase: 'EAST_WEST', rule: 'REST' });
  });

  it('serves the longest-starving phase first', () => {
    const s = initialState(cfg, 0);
    s.queues.NORTH = [vehicle('n', 'NORTH', 0)];
    s.queues.EAST = [vehicle('e', 'EAST', -50_000)];
    expect(chooseFromAllRed(cfg, s, 200_000)).toMatchObject({ phase: 'EAST_WEST', rule: 'STARVATION' });
  });

  it('forces a switch at max green and logs STAY decisions in between', () => {
    const h = runningJunction();
    const own = ownDir(h);
    for (let i = 0; i < 8; i++) h.sensor(own, 'VEHICLE_ARRIVED', `own${i}`, 'TRUCK');
    h.sensor(otherDir(h), 'VEHICLE_ARRIVED', 'lonely');
    h.advance(95_000);
    expect(h.audit.some((a) => a.type === 'PHASE_DECISION' && (a.details as { decision?: string }).decision === 'STAY')).toBe(true);
    expect(h.audit.some((a) => a.type === 'PHASE_DECISION' && (a.details as { rule: string }).rule === 'MAX_GREEN')).toBe(true);
    expect(types(h)).toContain('SIGNAL_TRANSITION_STARTED');
    expect(h.violations).toEqual([]);
  });
});

describe('safety guard edge cases (plan §3.4)', () => {
  const cfg = loadA();
  const ctx = { now: 10_000, confirmed: ALL_RED, allRedConfirmedAt: 0, health: 'OK' as const, holdActive: false, commandPending: false };
  const reason = (fn: () => void) => { try { fn(); return 'OK'; } catch (e) { return (e as UnsafeCommand).reason; } };
  it('rejects a vector with a missing group', () => expect(reason(() => assertSafeCommand(cfg, { NORTH: 'RED' } as AspectVector, ctx))).toBe('MISSING_ASPECT'));
  it('allows all-red while the physical state is unknown', () => expect(reason(() => assertSafeCommand(cfg, ALL_RED, { ...ctx, confirmed: null }))).toBe('OK'));
  it('rejects a green while a hold is active', () => expect(reason(() => assertSafeCommand(cfg, NS_GREEN, { ...ctx, holdActive: true }))).toBe('GREEN_NOT_ALLOWED_NOW'));
});

describe('config validation (plan §3.2)', () => {
  const base = () => structuredClone(configFromJson(A_JSON));
  const cases: [string, (c: ReturnType<typeof base>) => void, string][] = [
    ['malformed junction id', (c) => { c.junctionId = 'bad id'; }, 'V-1 junction_id'],
    ['duplicate approach', (c) => { c.approaches.push('NORTH'); }, 'V-1 duplicate approach'],
    ['bad id', (c) => { c.phases[0]!.id = 'lower'; }, 'V-1 bad id'],
    ['a single phase', (c) => { c.phases = c.phases.slice(0, 1); }, 'V-1 at least two phases'],
    ['group on unknown approach', (c) => { c.signalGroups[0]!.approach = 'UP'; }, 'V-2 group'],
    ['approach without a group', (c) => { c.approaches.push('UP'); }, 'V-2 approach UP'],
    ['unknown group in conflict', (c) => { c.conflicts.push(['NORTH', 'NOPE']); }, 'V-5 conflict'],
    ['self conflict', (c) => { c.conflicts.push(['NORTH', 'NORTH']); }, 'V-5 self'],
    ['unknown group in phase', (c) => { c.phases[0]!.signalGroups.push('NOPE'); }, 'V-1 phase'],
    ['all-red too short', (c) => { c.timings.allRedS = 0; }, 'V-7 all-red'],
    ['bad green timings', (c) => { c.timings.minGreenS = 1; }, 'V-7 need'],
    ['ack timeout too short', (c) => { c.controller.ackTimeoutMs = 100; }, 'V-7 ack timeout'],
    ['recovery timeout too short', (c) => { c.controller.recoveryTimeoutS = 1; }, 'V-7 recovery'],
    ['missing weight', (c) => { delete (c.scheduling.weights as Record<string, number>).TRUCK; }, 'V-8 missing'],
    ['hysteresis below 1', (c) => { c.scheduling.hysteresis = 0.5; }, 'V-8 hysteresis'],
    ['starvation below max green', (c) => { c.scheduling.starvationS = 60; }, 'V-8 starvation'],
  ];
  it.each(cases)('rejects %s', (_name, mutate, expected) => {
    const c = base();
    mutate(c);
    expect(validateConfig(c).some((e) => e.startsWith(expected))).toBe(true);
  });
  it('compileConfig refuses an invalid config', () => {
    const c = base();
    c.timings.yellowS = 1;
    expect(() => compileConfig(c)).toThrow(/Invalid junction config/);
  });
});
