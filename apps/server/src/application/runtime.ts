import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  compileConfig, initialState, validateConfig,
  type AckMessage, type CompiledConfig, type Decision, type DeviceStatus, type HeartbeatMessage, type JunctionConfig,
  type OperatorCommand, type Outcome, type PendingCommand, type SensorEvent,
} from '@ftms/domain';
import { canonical, sha256, type Store, type ActorType } from '../adapters/postgres/store.js';
import { JunctionActor } from './actor.js';
import { statusView } from './status.js';

export interface ControllerGateway {
  /** Fire-and-forget. A transport failure shows up later as a missing ACK. */
  send(junctionId: string, command: WireCommand): void;
}

export interface WireCommand {
  type: 'SET_ASPECTS' | 'SAFE_STOP';
  command_id: string; junction_id: string; seq: number; epoch: number;
  aspects?: Record<string, string>; issued_at: string; expires_at: string; attempt: number;
}

export const toWire = (junctionId: string, c: PendingCommand): WireCommand => ({
  type: c.kind, command_id: c.commandId, junction_id: junctionId, seq: c.seq, epoch: c.epoch,
  ...(c.target ? { aspects: c.target } : {}),
  issued_at: new Date(c.issuedAt).toISOString(), expires_at: new Date(c.expiresAt).toISOString(), attempt: c.attempt,
});

export class NotFound extends Error {}

/** Application layer: one actor per junction, timers, effects and live-update events. */
export class Runtime {
  readonly actors = new Map<string, JunctionActor>();
  readonly events = new EventEmitter();
  private timers = new Map<string, NodeJS.Timeout>();
  ready = false;

  constructor(private readonly store: Store, private readonly gateway: ControllerGateway, private readonly clock: () => number = Date.now) {
    this.events.setMaxListeners(500);
  }

  private newActor(cfg: CompiledConfig, state = initialState(cfg, this.clock())): JunctionActor {
    const actor = new JunctionActor(cfg, state, {
      now: this.clock,
      newId: (p) => `${p}-${randomUUID()}`,
      commit: (prev, d, meta, at) => this.store.commit(prev, d, meta, at),
      runEffects: (id, d) => this.runEffects(id, d),
      published: (s, d) => this.events.emit('change', { junctionId: s.junctionId, status: statusView(actor.config, s, this.clock()), audit: d.audit }),
    });
    this.actors.set(cfg.junctionId, actor);
    return actor;
  }

  private runEffects(junctionId: string, d: Decision) {
    for (const e of d.effects) {
      if (e.type === 'SEND_COMMAND') this.gateway.send(junctionId, toWire(junctionId, e.command));
      else {
        clearTimeout(this.timers.get(junctionId));
        const delay = Math.max(0, e.at - this.clock());
        this.timers.set(junctionId, setTimeout(() => {
          this.actor(junctionId).submit({ kind: 'WAKE', token: e.token }, { actorType: 'SCHEDULER' }).catch(() => undefined);
        }, Math.min(delay, 2 ** 31 - 1)));
      }
    }
  }

  actor(id: string): JunctionActor {
    const a = this.actors.get(id);
    if (!a) throw new NotFound(`Unknown junction ${id}`);
    return a;
  }

  status(id: string) {
    const a = this.actor(id);
    return statusView(a.config, a.snapshot, this.clock());
  }

  /** Startup recovery (plan §9.2): load, bump epoch, RECOVER every junction. */
  async start(): Promise<void> {
    for (const row of await this.store.loadJunctions()) {
      const cfg = compileConfig(row.config);
      const epoch = await this.store.bumpEpoch(cfg.junctionId);
      const state = row.state ?? initialState(cfg, this.clock());
      const actor = this.newActor(cfg, { ...state, epoch });
      await actor.submit({ kind: 'RECOVER' }, { actorType: 'SYSTEM' });
    }
    this.ready = true;
  }

  stop() {
    for (const t of this.timers.values()) clearTimeout(t);
  }

  async createJunction(config: JunctionConfig, by: string): Promise<{ ok: true } | { ok: false; code: string; errors?: string[] }> {
    const errors = validateConfig(config);
    if (errors.length) return { ok: false, code: 'INVALID_CONFIG', errors };
    if (!(await this.store.createJunction(config, by))) return { ok: false, code: 'JUNCTION_EXISTS' };
    const cfg = compileConfig(config);
    const epoch = await this.store.bumpEpoch(cfg.junctionId);
    const actor = this.newActor(cfg, { ...initialState(cfg, this.clock()), epoch });
    await actor.submit({ kind: 'RECOVER' }, { actorType: 'SYSTEM', actorId: by });
    return { ok: true };
  }

  /** Sensor events: de-duplicated by (source_id, event_id) with a payload hash (plan §5.2). */
  async sensorEvent(ev: SensorEvent, sourceId: string, actorType: ActorType): Promise<Outcome & { duplicate?: boolean; conflict?: boolean }> {
    const actor = this.actor(ev.junctionId);
    const payloadHash = sha256(canonical(ev));
    return actor.submit(
      { kind: 'SENSOR_EVENT', event: ev, sourceId },
      { actorType, actorId: sourceId, processedEvent: { sourceId, eventId: ev.eventId, payloadHash } },
      () => this.duplicateCheck(sourceId, ev.eventId, payloadHash, ev.junctionId),
    );
  }

  async deviceStatus(st: DeviceStatus, sourceId: string, actorType: ActorType) {
    const actor = this.actor(st.junctionId);
    const payloadHash = sha256(canonical(st));
    return actor.submit(
      { kind: 'DEVICE_STATUS', status: st, sourceId },
      { actorType, actorId: sourceId, processedEvent: { sourceId, eventId: st.eventId, payloadHash } },
      () => this.duplicateCheck(sourceId, st.eventId, payloadHash, st.junctionId),
    );
  }

  private async duplicateCheck(sourceId: string, eventId: string, hash: Buffer, junctionId: string): Promise<Outcome | null> {
    const prior = await this.store.findProcessed(sourceId, eventId);
    if (!prior) return null;
    if (prior.payloadHash.equals(hash)) {
      await this.store.audit(junctionId, junctionId, [{ type: 'SENSOR_EVENT_DUPLICATE', severity: 'INFO', correlationId: eventId, details: { sourceId } }], 'DEVICE', sourceId);
      return { ...(prior.outcome as Outcome), duplicate: true } as Outcome;
    }
    await this.store.audit(junctionId, junctionId, [{ type: 'EVENT_ID_CONFLICT', severity: 'SECURITY', correlationId: eventId, details: { sourceId } }], 'DEVICE', sourceId);
    return { ok: false, code: 'EVENT_ID_REUSED', conflict: true } as Outcome;
  }

  async controllerMessage(junctionId: string, msg: AckMessage | HeartbeatMessage, sourceId: string, actorType: ActorType): Promise<Outcome> {
    const actor = this.actor(junctionId);
    if (msg.type === 'ACK') {
      const known = await this.store.commandExists(msg.commandId, junctionId);
      if (known !== 'KNOWN') {
        await this.store.audit(junctionId, junctionId, [{ type: 'UNKNOWN_COMMAND_ACK', severity: 'SECURITY', correlationId: msg.commandId, details: { sourceId, known } }], actorType, sourceId);
        return { ok: false, code: known === 'NONE' ? 'UNKNOWN_COMMAND' : 'COMMAND_JUNCTION_MISMATCH' };
      }
    }
    return actor.submit({ kind: 'CONTROLLER_MESSAGE', message: msg }, { actorType, actorId: sourceId });
  }

  async operatorCommand(junctionId: string, cmd: OperatorCommand, user: string, opts: { expectedVersion?: number; idempotencyKey?: string }) {
    const actor = this.actor(junctionId);
    if (opts.idempotencyKey) {
      const prior = await this.store.findOperatorRequest(user, opts.idempotencyKey);
      if (prior) return { ...(prior as Outcome), request_id: 'replayed', junction_version: actor.snapshot.version, replayed: true };
    }
    const requestId = `req-${randomUUID()}`;
    const outcome = await actor.submit(
      { kind: 'OPERATOR_COMMAND', command: cmd, actor: user, requestId, ...(opts.expectedVersion !== undefined ? { expectedVersion: opts.expectedVersion } : {}) },
      { actorType: 'OPERATOR', actorId: user, operatorRequest: { requestId, command: cmd.command, payload: cmd, requestedBy: user, ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}) } },
    );
    return { ...outcome, request_id: requestId, junction_version: actor.snapshot.version };
  }
}
