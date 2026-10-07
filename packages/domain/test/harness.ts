import { readFileSync } from 'node:fs';
import { ControllerModel, type AckReply } from '@ftms/sim-core';
import {
  compileConfig, configFromJson, decide, initialState,
  type AuditRecord, type CompiledConfig, type Decision, type Input, type JunctionState, type OperatorCommand,
} from '../src/index.js';

export const A_JSON = JSON.parse(readFileSync(new URL('../../../config/junctions/A.json', import.meta.url), 'utf8'));
export const loadA = (): CompiledConfig => compileConfig(configFromJson(A_JSON));

type Pending = { at: number; seq: number; run: () => void };

/** Runs the pure domain against the physical controller model on a fake clock (plan §16.3). */
export class Harness {
  now = 1_000_000;
  cfg = loadA();
  state: JunctionState;
  ctrl: ControllerModel;
  ackLatencyMs = 100;
  heartbeats = true;
  audit: AuditRecord[] = [];
  outcomes: Decision['outcome'][] = [];
  violations: string[] = [];
  nackUnsafe = 0;
  private queue: Pending[] = [];
  private order = 0;
  private wake: { at: number; token: number } | null = null;
  private ids = 0;
  private nextHeartbeat: number;
  private lastNonRed: Record<string, number> = {};
  private yellowSince: Record<string, number> = {};

  constructor() {
    this.state = initialState(this.cfg, this.now);
    this.ctrl = new ControllerModel('A', this.cfg.groupIds, this.cfg.conflicts, 3000, 1000, this.now);
    for (const g of this.cfg.groupIds) this.lastNonRed[g] = -Infinity;
    this.nextHeartbeat = this.now;
  }

  input(input: Input): Decision['outcome'] {
    const decision = decide({ config: this.cfg, now: this.now, newId: (p) => `${p}-${++this.ids}` }, this.state, input);
    this.state = decision.state;
    this.audit.push(...decision.audit);
    this.outcomes.push(decision.outcome);
    for (const e of decision.effects) {
      if (e.type === 'SCHEDULE_WAKE') this.wake = { at: e.at, token: e.token };
      else {
        const c = e.command;
        const wire = {
          type: c.kind, command_id: c.commandId, junction_id: 'A', seq: c.seq, epoch: c.epoch,
          ...(c.target ? { aspects: c.target } : {}), issued_at: c.issuedAt, expires_at: c.expiresAt, attempt: c.attempt,
        };
        this.at(this.now + 10, () => this.physical(true, () => this.deliver(this.ctrl.handle(wire, this.now))));
      }
    }
    return decision.outcome;
  }

  sensor(direction: string, eventType: 'VEHICLE_ARRIVED' | 'VEHICLE_CLEARED', vehicleId: string, vehicleType = 'EMPLOYEE_VEHICLE', extra: { eventId?: string; seq?: number; ts?: number; source?: string } = {}) {
    return this.input({
      kind: 'SENSOR_EVENT', sourceId: extra.source ?? `sensor-${direction}`,
      event: {
        eventId: extra.eventId ?? `evt-${++this.ids}`, junctionId: 'A', direction, eventType, vehicleId,
        vehicleType, sequenceNo: extra.seq ?? ++this.ids, timestamp: extra.ts ?? this.now,
      },
    });
  }

  command(command: OperatorCommand, expectedVersion?: number) {
    return this.input({ kind: 'OPERATOR_COMMAND', command, actor: 'op', requestId: `req-${++this.ids}`, ...(expectedVersion !== undefined ? { expectedVersion } : {}) });
  }

  /** Advances the fake clock, delivering ACKs, heartbeats, controller ticks and domain wakes in time order. */
  advance(ms: number) {
    const end = this.now + ms;
    for (;;) {
      const candidates: number[] = [end];
      if (this.queue[0]) candidates.push(this.queue[0].at);
      if (this.wake) candidates.push(this.wake.at);
      if (this.heartbeats) candidates.push(this.nextHeartbeat);
      const tick = this.ctrl.nextTickAt();
      if (tick !== null) candidates.push(tick);
      const t = Math.max(this.now, Math.min(...candidates));
      if (t > end) break;
      this.now = t;
      if (this.queue[0] && this.queue[0].at <= t) { this.queue.shift()!.run(); continue; }
      if (tick !== null && tick <= t) { this.physical(false, () => this.deliver(this.ctrl.tick(this.now))); continue; }
      if (this.heartbeats && this.nextHeartbeat <= t) {
        this.nextHeartbeat = t + 5000;
        const hb = this.ctrl.heartbeat(t);
        if (hb) this.input({ kind: 'CONTROLLER_MESSAGE', message: { type: 'HEARTBEAT', aspects: hb.aspects, lastAppliedCommandId: hb.last_applied_command_id } });
        continue;
      }
      if (this.wake && this.wake.at <= t) {
        const w = this.wake; this.wake = null;
        this.input({ kind: 'WAKE', token: w.token });
        continue;
      }
      if (t >= end) break;
    }
    this.now = end;
  }

  physicalAspects() { return { ...this.ctrl.aspects }; }

  private at(at: number, run: () => void) {
    this.queue.push({ at, seq: ++this.order, run });
    this.queue.sort((a, b) => a.at - b.at || a.seq - b.seq);
  }

  private deliver(reply: AckReply | null) {
    if (!reply) return;
    if (reply.status === 'NACK' && reply.reason === 'UNSAFE') this.nackUnsafe++;
    this.at(this.now + this.ackLatencyMs, () => this.input({
      kind: 'CONTROLLER_MESSAGE',
      message: { type: 'ACK', commandId: reply.command_id, status: reply.status, actualAspects: reply.actual_aspects, ...(reply.reason ? { reason: reply.reason } : {}) },
    }));
  }

  /** Records the physical timeline and checks safety invariants P-1..P-3 on every physical change. */
  private physical(commanded: boolean, change: () => void) {
    const before = { ...this.ctrl.aspects };
    change();
    const after = this.ctrl.aspects;
    for (const [a, b] of this.cfg.conflicts) {
      const p = (x?: string) => x === 'GREEN' || x === 'YELLOW';
      if (p(after[a]) && p(after[b])) this.violations.push(`P-1 conflicting permissive ${a}/${b} at ${this.now}`);
    }
    for (const g of this.cfg.groupIds) {
      if (before[g] !== 'GREEN' && after[g] === 'GREEN') {
        for (const [a, b] of this.cfg.conflicts) {
          const other = a === g ? b : b === g ? a : null;
          if (other && this.now - (this.lastNonRed[other] ?? -Infinity) < this.cfg.ms.allRed) this.violations.push(`P-2 ${g} green ${this.now - this.lastNonRed[other]!} ms after ${other} was not red`);
        }
      }
      if (before[g] !== 'YELLOW' && after[g] === 'YELLOW') this.yellowSince[g] = this.now;
      if (commanded && before[g] === 'YELLOW' && after[g] === 'RED' && this.now - (this.yellowSince[g] ?? 0) < this.cfg.ms.yellow) {
        this.violations.push(`P-3 ${g} yellow lasted ${this.now - this.yellowSince[g]!} ms`);
      }
      if (before[g] === 'GREEN' && after[g] === 'RED') this.violations.push(`I-3 ${g} went GREEN to RED`);
    }
    for (const g of this.cfg.groupIds) if (before[g] !== 'RED' || after[g] !== 'RED') this.lastNonRed[g] = this.now;
  }
}

/** A junction that is commissioned, recovered and resting in a confirmed phase. */
export function runningJunction(): Harness {
  const h = new Harness();
  h.advance(1);          // first heartbeat commissions the controller and triggers SAFE_STOP
  h.advance(10_000);     // SAFE_STOP ack, all-red clearance, first green
  return h;
}

export const types = (h: Harness) => h.audit.map((a) => a.type);
