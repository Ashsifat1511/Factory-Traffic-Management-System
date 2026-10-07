import { describe, expect, it } from 'vitest';
import { A_JSON, loadA, runningJunction, types } from './harness.js';
import {
  assertSafeCommand, configFromJson, health, specMode, UnsafeCommand, validateConfig, scorePhases, initialState,
} from '../src/index.js';

const clone = () => structuredClone(configFromJson(A_JSON));

describe('config validation (V-1..V-8)', () => {
  it('accepts Junction A', () => expect(validateConfig(clone())).toEqual([]));
  it('rejects a phase that contains conflicting groups (V-3)', () => {
    const c = clone();
    c.phases[0]!.signalGroups.push('EAST');
    expect(validateConfig(c).some((e) => e.startsWith('V-3'))).toBe(true);
  });
  it('rejects an approach that can never get green (V-4)', () => {
    const c = clone();
    c.phases[1]!.signalGroups = ['EAST'];
    expect(validateConfig(c).some((e) => e.startsWith('V-4'))).toBe(true);
  });
  it('rejects an undeclared conflict (V-6)', () => {
    const c = clone();
    c.conflicts = c.conflicts.slice(1);
    expect(validateConfig(c).some((e) => e.startsWith('V-6'))).toBe(true);
  });
  it('rejects unsafe timings (V-7)', () => {
    const c = clone();
    c.timings.yellowS = 1;
    expect(validateConfig(c).some((e) => e.startsWith('V-7'))).toBe(true);
  });
});

describe('safety guard', () => {
  const cfg = loadA();
  const ctx = { now: 10_000, confirmed: { NORTH: 'RED', SOUTH: 'RED', EAST: 'RED', WEST: 'RED' } as const, allRedConfirmedAt: 0, health: 'OK' as const, holdActive: false, commandPending: false };
  const v = (n: string, s: string, e: string, w: string) => ({ NORTH: n, SOUTH: s, EAST: e, WEST: w }) as never;
  const reason = (fn: () => void) => { try { fn(); return 'OK'; } catch (e) { return (e as UnsafeCommand).reason; } };
  it('rejects conflicting greens', () => expect(reason(() => assertSafeCommand(cfg, v('GREEN', 'RED', 'GREEN', 'RED'), { ...ctx, confirmed: { ...ctx.confirmed } }))).toBe('CONFLICTING_PERMISSIVE'));
  it('rejects GREEN to RED without yellow', () => expect(reason(() => assertSafeCommand(cfg, v('RED', 'RED', 'RED', 'RED'), { ...ctx, confirmed: { NORTH: 'GREEN', SOUTH: 'GREEN', EAST: 'RED', WEST: 'RED' } }))).toBe('ILLEGAL_STEP'));
  it('rejects green before clearance', () => expect(reason(() => assertSafeCommand(cfg, v('GREEN', 'GREEN', 'RED', 'RED'), { ...ctx, allRedConfirmedAt: 9_000 }))).toBe('CLEARANCE_NOT_MET'));
  it('rejects green while state is unknown', () => expect(reason(() => assertSafeCommand(cfg, v('GREEN', 'GREEN', 'RED', 'RED'), { ...ctx, confirmed: null }))).toBe('PHYSICAL_STATE_UNKNOWN'));
  it('rejects green while FAILED', () => expect(reason(() => assertSafeCommand(cfg, v('GREEN', 'GREEN', 'RED', 'RED'), { ...ctx, health: 'FAILED' }))).toBe('GREEN_NOT_ALLOWED_NOW'));
  it('accepts a normal green', () => expect(reason(() => assertSafeCommand(cfg, v('GREEN', 'GREEN', 'RED', 'RED'), ctx))).toBe('OK'));
});

describe('startup and recovery', () => {
  it('sends SAFE_STOP first and only goes green after a confirmed all-red', () => {
    const h = runningJunction();
    const t = types(h);
    expect(t.indexOf('RECOVERY_COMPLETED')).toBeGreaterThan(-1);
    expect(h.state.interval.kind).toBe('GREEN');
    expect(health(h.state)).toBe('OK');
    expect(h.violations).toEqual([]);
  });
  it('restart mid-transition: never trusts the old state (scenario 8)', () => {
    const h = runningJunction();
    h.sensor('EAST', 'VEHICLE_ARRIVED', 'T1', 'TRUCK');
    h.advance(31_000);                     // decision -> yellow requested
    h.state = { ...h.state, epoch: h.state.epoch + 1 };
    h.input({ kind: 'RECOVER' });
    expect(h.state.interval.kind).toBe('UNKNOWN');
    expect(h.state.pending?.kind).toBe('SAFE_STOP');
    h.advance(20_000);
    expect(h.violations).toEqual([]);
    expect(health(h.state)).toBe('OK');
    expect(h.state.interval.kind).toBe('GREEN');
  });
});

describe('scheduling (scenarios 1 and 2)', () => {
  it('one truck changes the decision (plan §4.3 worked example)', () => {
    const cfg = loadA();
    const s = initialState(cfg, 0);
    s.queues.NORTH = [0, 1].map((i) => ({ vehicleId: `n${i}`, type: 'EMPLOYEE_VEHICLE' as const, approach: 'NORTH', queuedAt: 0, sensorTs: 0, sourceId: 's', seq: i, eventId: `e${i}` }));
    s.queues.EAST = [{ vehicleId: 't', type: 'TRUCK', approach: 'EAST', queuedAt: -10_000, sensorTs: 0, sourceId: 's', seq: 3, eventId: 'e3' }];
    s.queues.WEST = [{ vehicleId: 'f', type: 'FORKLIFT', approach: 'WEST', queuedAt: 20_000, sensorTs: 0, sourceId: 's', seq: 4, eventId: 'e4' }];
    const [ns, ew] = scorePhases(cfg, s, 30_000);
    expect(ns!.score).toBeCloseTo(3.0, 2);
    expect(ew!.score).toBeCloseTo(11.833, 2);
  });
  it('gap-out switches to the waiting phase after min green', () => {
    const h = runningJunction();
    const green = (h.state.interval as { phase: string }).phase;
    const other = green === 'NORTH_SOUTH' ? 'EAST' : 'NORTH';
    h.sensor(other, 'VEHICLE_ARRIVED', 'V1');
    h.advance(25_000);
    expect(h.state.interval.kind === 'GREEN' && h.state.interval.phase !== green).toBe(true);
    expect(h.violations).toEqual([]);
  });
});

describe('sensor events (scenarios 5 and 6)', () => {
  it('queues never go negative and orphan clears change nothing', () => {
    const h = runningJunction();
    expect(h.sensor('NORTH', 'VEHICLE_ARRIVED', 'VH-501').code).toBe('QUEUED');
    expect(h.state.queues.NORTH).toHaveLength(1);
    expect(h.sensor('NORTH', 'VEHICLE_CLEARED', 'VH-501').code).toBe('CLEARED');
    expect(h.sensor('NORTH', 'VEHICLE_CLEARED', 'VH-501').code).toBe('ORPHAN_CLEAR');
    expect(h.state.queues.NORTH).toHaveLength(0);
  });
  it('a CLEARED that arrives before its ARRIVED leaves no phantom vehicle', () => {
    const h = runningJunction();
    h.sensor('NORTH', 'VEHICLE_CLEARED', 'VH-9', undefined, { seq: 1502, source: 's1' });
    expect(h.sensor('NORTH', 'VEHICLE_ARRIVED', 'VH-9', 'TRUCK', { seq: 1501, source: 's1' }).code).toBe('IGNORED_OUT_OF_ORDER');
    expect(h.state.queues.NORTH).toHaveLength(0);
  });
  it('stale arrivals and unknown types', () => {
    const h = runningJunction();
    expect(h.sensor('NORTH', 'VEHICLE_ARRIVED', 'old', 'TRUCK', { ts: h.now - 400_000 }).code).toBe('IGNORED_STALE');
    expect(h.sensor('NORTH', 'VEHICLE_ARRIVED', 'u', 'SPACESHIP').code).toBe('QUEUED');
    expect(h.state.queues.NORTH![0]!.type).toBe('UNKNOWN');
    expect(h.sensor('NORTH', 'VEHICLE_ARRIVED', 'f', 'TRUCK', { ts: h.now + 600_000 }).code).toBe('TIMESTAMP_IN_FUTURE');
  });
});

describe('emergency (scenario 3)', () => {
  it('preempts through YELLOW and ALL_RED, never directly', () => {
    const h = runningJunction();
    const green = (h.state.interval as { phase: string }).phase;
    const dir = green === 'NORTH_SOUTH' ? 'EAST' : 'NORTH';
    expect(h.sensor(dir, 'VEHICLE_ARRIVED', 'EV-1', 'EMERGENCY').code).toBe('EMERGENCY_STARTED');
    expect(h.state.pending?.step).toBe('YELLOW');
    expect(specMode(h.state, h.now)).toBe('EMERGENCY');
    h.advance(10_000);
    expect(h.state.interval.kind === 'GREEN' && h.state.interval.phase !== green).toBe(true);
    h.advance(60_000);
    expect((h.state.interval as { phase: string }).phase).not.toBe(green); // held while the emergency is active
    h.sensor(dir, 'VEHICLE_CLEARED', 'EV-1');
    expect(h.state.emergencies).toHaveLength(0);
    expect(h.violations).toEqual([]);
  });
  it('manual requests are refused during an emergency', () => {
    const h = runningJunction();
    h.sensor('EAST', 'VEHICLE_ARRIVED', 'EV-1', 'EMERGENCY');
    expect(h.command({ command: 'MANUAL_GREEN_REQUEST', direction: 'WEST', reason: 'x' }).code).toBe('EMERGENCY_ACTIVE');
  });
});

describe('manual control (scenario 4)', () => {
  it('holds the requested phase and returns to automatic', () => {
    const h = runningJunction();
    const green = (h.state.interval as { phase: string }).phase;
    const dir = green === 'NORTH_SOUTH' ? 'WEST' : 'NORTH';
    const out = h.command({ command: 'MANUAL_GREEN_REQUEST', direction: dir, reason: 'convoy' }, h.state.version);
    expect(out.code).toBe('ACCEPTED');
    h.advance(20_000);
    expect((h.state.interval as { phase: string }).phase).not.toBe(green);
    expect(specMode(h.state, h.now)).toBe('MANUAL');
    expect(h.command({ command: 'RETURN_TO_AUTOMATIC' }).code).toBe('ACCEPTED');
    expect(specMode(h.state, h.now)).toBe('AUTOMATIC');
    expect(h.violations).toEqual([]);
  });
  it('rejects a command made against an outdated version', () => {
    const h = runningJunction();
    const v = h.state.version;
    h.sensor('NORTH', 'VEHICLE_ARRIVED', 'x');
    expect(h.command({ command: 'MANUAL_GREEN_REQUEST', direction: 'WEST', reason: 'r' }, v).code).toBe('STALE_VERSION');
  });
});

describe('controller failures (scenario 7)', () => {
  it('missing ACKs: retries, then FAILED and SAFE_STOP; never assumes success', () => {
    const h = runningJunction();
    h.ctrl.faults.dropAcks = true;
    h.heartbeats = false; // otherwise a heartbeat would confirm the command (CONFIRMED_BY_HEARTBEAT)
    h.command({ command: 'ALL_RED_HOLD', reason: 'test' });
    h.advance(8_000);
    expect(types(h)).toContain('CONTROLLER_RETRY');
    expect(types(h)).toContain('CONTROLLER_TIMEOUT');
    expect(health(h.state)).toBe('FAILED');
    expect(h.violations).toEqual([]);
  });
  it('offline controller: FAILED, then automatic recovery after reconnect', () => {
    const h = runningJunction();
    h.ctrl.faults.offline = true;
    h.advance(20_000);
    expect(h.state.faults.map((f) => f.code)).toContain('CONTROLLER_OFFLINE');
    expect(h.state.interval.kind).toBe('UNKNOWN');
    h.ctrl.faults.offline = false;
    h.advance(20_000);
    expect(health(h.state)).toBe('OK');
    expect(h.violations).toEqual([]);
  });
  it('wrong state reported: needs operator resume', () => {
    const h = runningJunction();
    h.ctrl.faults.wrongStateNext = true;
    h.command({ command: 'ALL_RED_HOLD', reason: 'test' });
    h.advance(2_000);
    expect(h.state.faults.map((f) => f.code)).toContain('STATE_MISMATCH');
    h.advance(30_000);
    expect(health(h.state)).toBe('FAILED');
    expect(h.command({ command: 'RESUME_AFTER_FAULT', reason: 'checked on site' }).code).toBe('ACCEPTED');
    h.command({ command: 'RELEASE_HOLD' });
    h.advance(20_000);
    expect(health(h.state)).toBe('OK');
    expect(h.violations).toEqual([]);
  });
});

describe('concurrent events (scenario 9)', () => {
  it('stays consistent and safe', () => {
    const h = runningJunction();
    h.ackLatencyMs = 13;
    const green = (h.state.interval as { phase: string }).phase;
    const [dirA, dirB] = green === 'NORTH_SOUTH' ? ['NORTH', 'EAST'] : ['EAST', 'NORTH'];
    const r1 = h.sensor(dirA, 'VEHICLE_ARRIVED', 'TR-1', 'TRUCK');
    h.advance(4);
    const r2 = h.sensor(dirB, 'VEHICLE_ARRIVED', 'EV-1', 'EMERGENCY', { eventId: 'evt-em' });
    h.advance(4);
    const r3 = h.command({ command: 'MANUAL_GREEN_REQUEST', direction: 'WEST', reason: 'x' });
    h.advance(4);
    expect([r1.code, r2.code, r3.code]).toEqual(['QUEUED', 'EMERGENCY_STARTED', 'EMERGENCY_ACTIVE']);
    h.advance(20_000);
    expect(h.violations).toEqual([]);
    expect(h.nackUnsafe).toBe(0);
  });
});
