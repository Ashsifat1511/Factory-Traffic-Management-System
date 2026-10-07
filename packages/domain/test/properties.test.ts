import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Harness, runningJunction } from './harness.js';

const DIRS = ['NORTH', 'SOUTH', 'EAST', 'WEST'];
const TYPES = ['EMPLOYEE_VEHICLE', 'TRUCK', 'FORKLIFT', 'MATERIAL_CARRIER', 'EMERGENCY', 'BUS'];
const VEHICLES = ['v1', 'v2', 'v3', 'v4', 'v5', 'v6'];

const step = fc.oneof(
  fc.record({ k: fc.constant('time' as const), ms: fc.integer({ min: 0, max: 40_000 }) }),
  fc.record({ k: fc.constant('arrive' as const), dir: fc.constantFrom(...DIRS), v: fc.constantFrom(...VEHICLES), t: fc.constantFrom(...TYPES) }),
  fc.record({ k: fc.constant('clear' as const), dir: fc.constantFrom(...DIRS), v: fc.constantFrom(...VEHICLES) }),
  fc.record({ k: fc.constant('manual' as const), dir: fc.constantFrom(...DIRS) }),
  fc.record({ k: fc.constantFrom('auto' as const, 'hold' as const, 'release' as const, 'cancel' as const, 'resume' as const) }),
  fc.record({ k: fc.constant('fault' as const), f: fc.constantFrom('dropNextAck', 'nackNext', 'wrongStateNext', 'offline', 'online', 'latency') }),
);

type StepT = typeof step extends fc.Arbitrary<infer T> ? T : never;
function apply(h: Harness, s: StepT) {
  switch (s.k) {
    case 'time': h.advance(s.ms); break;
    case 'arrive': h.sensor(s.dir, 'VEHICLE_ARRIVED', s.v, s.t); break;
    case 'clear': h.sensor(s.dir, 'VEHICLE_CLEARED', s.v); break;
    case 'manual': h.command({ command: 'MANUAL_GREEN_REQUEST', direction: s.dir, reason: 'p' }); break;
    case 'auto': h.command({ command: 'RETURN_TO_AUTOMATIC' }); break;
    case 'hold': h.command({ command: 'ALL_RED_HOLD', reason: 'p' }); break;
    case 'release': h.command({ command: 'RELEASE_HOLD' }); break;
    case 'cancel': h.command({ command: 'EMERGENCY_CANCEL', reason: 'p' }); break;
    case 'resume': h.command({ command: 'RESUME_AFTER_FAULT', reason: 'p' }); break;
    case 'fault':
      if (s.f === 'offline') h.ctrl.faults.offline = true;
      else if (s.f === 'online') h.ctrl.faults.offline = false;
      else if (s.f === 'latency') h.ackLatencyMs = h.ackLatencyMs === 100 ? 2500 : 100;
      else h.ctrl.faults[s.f as 'dropNextAck' | 'nackNext' | 'wrongStateNext'] = true;
      break;
  }
}

describe('property-based safety (plan §16.3)', () => {
  it('P-1..P-5: no conflicting permissive aspects, proper clearance and yellow, no guard trips, sane queues', () => {
    fc.assert(
      fc.property(fc.array(step, { minLength: 1, maxLength: 120 }), (steps) => {
        const h = runningJunction();
        for (const s of steps) {
          apply(h, s);
          const seen = new Set<string>();
          for (const list of Object.values(h.state.queues)) for (const v of list) {
            expect(seen.has(v.vehicleId)).toBe(false); // a vehicle is in at most one queue
            seen.add(v.vehicleId);
          }
        }
        h.advance(60_000);
        expect(h.violations).toEqual([]);
        expect(h.audit.some((a) => a.type === 'SAFETY_GUARD_TRIPPED')).toBe(false);
      }),
      { numRuns: 300, seed: 42 },
    );
  });

  it('P-6: processing the same input twice is deterministic (P-7)', () => {
    fc.assert(
      fc.property(fc.array(step, { minLength: 1, maxLength: 60 }), (steps) => {
        const a = runningJunction();
        const b = runningJunction();
        for (const s of steps) { apply(a, s); apply(b, s); }
        expect(a.state).toEqual(b.state);
      }),
      { numRuns: 50, seed: 7 },
    );
  });

  it('P-9: with a faithful controller the local monitor never has to refuse a command', () => {
    fc.assert(
      fc.property(fc.array(step.filter((s) => s.k !== 'fault'), { minLength: 1, maxLength: 120 }), (steps) => {
        const h = runningJunction();
        for (const s of steps) apply(h, s);
        h.advance(60_000);
        expect(h.nackUnsafe).toBe(0);
        expect(h.violations).toEqual([]);
      }),
      { numRuns: 200, seed: 3 },
    );
  });
});
