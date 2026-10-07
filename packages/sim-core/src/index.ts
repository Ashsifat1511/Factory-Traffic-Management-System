/**
 * Physical junction controller model (plan §8.2, rules C-1..C-6). Zero dependencies.
 * Used by the controller simulator process and by the domain property tests as "the physical world".
 */
export type Aspect = 'RED' | 'YELLOW' | 'GREEN';
export type AspectVector = Record<string, Aspect>;

export interface ControllerCommand {
  type: 'SET_ASPECTS' | 'SAFE_STOP';
  command_id: string;
  junction_id: string;
  seq: number;
  epoch: number;
  aspects?: AspectVector;
  issued_at: number;
  expires_at: number;
  attempt: number;
}

export interface AckReply {
  type: 'ACK';
  command_id: string;
  junction_id: string;
  status: 'ACK' | 'NACK' | 'FAILED';
  reason?: string;
  actual_aspects: AspectVector;
  controller_ts: number;
}

export interface Faults {
  dropAcks: boolean;
  dropNextAck: boolean;
  nackNext: boolean;
  wrongStateNext: boolean;
  offline: boolean;
  unsafeHeartbeat: boolean;
}

const permissive = (a: Aspect | undefined) => a === 'GREEN' || a === 'YELLOW';
const LEGAL: Record<Aspect, Aspect[]> = { GREEN: ['GREEN', 'YELLOW'], YELLOW: ['YELLOW', 'RED'], RED: ['RED', 'GREEN'] };

export class ControllerModel {
  aspects: AspectVector;
  private lastEpoch = -1;
  private lastSeq = -1;
  private lastCommandId: string | null = null;
  private lastAppliedCommandId: string | null = null;
  private yellowSince: Record<string, number> = {};
  private allRedSince: number;
  /** A SAFE_STOP that is still clearing (yellow phase) completes at this time. */
  private stopping: { commandId: string; doneAt: number } | null = null;
  faults: Faults = { dropAcks: false, dropNextAck: false, nackNext: false, wrongStateNext: false, offline: false, unsafeHeartbeat: false };

  constructor(
    public readonly junctionId: string,
    private readonly groups: string[],
    private readonly conflicts: [string, string][],
    private readonly localYellowMs = 3000,
    private readonly localAllRedMs = 1000,
    now = 0,
  ) {
    this.aspects = Object.fromEntries(groups.map((g) => [g, 'RED' as Aspect]));
    this.allRedSince = now;
  }

  /** Executes a command and returns the reply, or null when no reply is sent (dropped, offline, or still clearing). */
  handle(cmd: ControllerCommand, now: number): AckReply | null {
    if (this.faults.offline) return null;
    const reply = (status: AckReply['status'], reason?: string): AckReply | null => {
      if (this.faults.dropAcks) return null;
      if (this.faults.dropNextAck) { this.faults.dropNextAck = false; return null; }
      return { type: 'ACK', command_id: cmd.command_id, junction_id: this.junctionId, status, ...(reason ? { reason } : {}), actual_aspects: { ...this.aspects }, controller_ts: now };
    };
    // C-1 fencing (a retry of the last command is re-acknowledged).
    if (cmd.command_id === this.lastCommandId) return this.stopping?.commandId === cmd.command_id ? null : reply('ACK');
    if (cmd.epoch < this.lastEpoch || (cmd.epoch === this.lastEpoch && cmd.seq <= this.lastSeq)) return reply('NACK', 'STALE_SEQ');
    // C-2 expiry.
    if (now > cmd.expires_at) return reply('NACK', 'EXPIRED');
    if (this.faults.nackNext) { this.faults.nackNext = false; return reply('NACK', 'HARDWARE_FAULT'); }
    this.lastEpoch = cmd.epoch;
    this.lastSeq = cmd.seq;
    this.lastCommandId = cmd.command_id;

    if (cmd.type === 'SAFE_STOP') {
      const anyGreen = this.groups.some((g) => this.aspects[g] === 'GREEN');
      const anyYellow = this.groups.some((g) => this.aspects[g] === 'YELLOW');
      for (const g of this.groups) if (this.aspects[g] === 'GREEN') { this.aspects[g] = 'YELLOW'; this.yellowSince[g] = now; }
      if (!anyGreen && !anyYellow) { this.lastAppliedCommandId = cmd.command_id; return reply('ACK'); }
      const doneAt = Math.max(...this.groups.filter((g) => this.aspects[g] === 'YELLOW').map((g) => (this.yellowSince[g] ?? now) + this.localYellowMs));
      this.stopping = { commandId: cmd.command_id, doneAt };
      return null; // ACK is sent by tick() once everything is RED
    }

    const next = cmd.aspects!;
    // C-3 local conflict monitor and legal steps.
    const unsafe = this.conflicts.some(([a, b]) => permissive(next[a]) && permissive(next[b]))
      || this.groups.some((g) => !next[g] || !LEGAL[this.aspects[g]!].includes(next[g]!))
      || this.groups.some((g) => this.aspects[g] === 'YELLOW' && next[g] === 'RED' && now - (this.yellowSince[g] ?? 0) < this.localYellowMs)
      || this.groups.some((g) => this.aspects[g] === 'RED' && next[g] === 'GREEN' && now - this.allRedSince < this.localAllRedMs);
    if (unsafe) return reply('NACK', 'UNSAFE');
    this.stopping = null;
    this.apply(next, now);
    this.lastAppliedCommandId = cmd.command_id;
    if (this.faults.wrongStateNext) {
      this.faults.wrongStateNext = false;
      const r = reply('ACK');
      if (r) r.actual_aspects = Object.fromEntries(this.groups.map((g) => [g, 'RED' as Aspect]));
      return r;
    }
    return reply('ACK');
  }

  /** Advances local timers (SAFE_STOP clearance). Returns a delayed ACK when a SAFE_STOP completes. */
  tick(now: number): AckReply | null {
    if (!this.stopping || now < this.stopping.doneAt) return null;
    const id = this.stopping.commandId;
    this.stopping = null;
    this.apply(Object.fromEntries(this.groups.map((g) => [g, 'RED' as Aspect])), now);
    this.lastAppliedCommandId = id;
    if (this.faults.offline || this.faults.dropAcks) return null;
    return { type: 'ACK', command_id: id, junction_id: this.junctionId, status: 'ACK', actual_aspects: { ...this.aspects }, controller_ts: now };
  }

  nextTickAt(): number | null { return this.stopping?.doneAt ?? null; }

  /** Local fail-safe (rule C-6): clear every head to RED through yellow without touching command fencing. */
  localSafeStop(now: number): void {
    if (this.stopping) return;
    for (const g of this.groups) if (this.aspects[g] === 'GREEN') { this.aspects[g] = 'YELLOW'; this.yellowSince[g] = now; }
    const yellow = this.groups.filter((g) => this.aspects[g] === 'YELLOW');
    if (yellow.length === 0) return;
    this.stopping = { commandId: this.lastAppliedCommandId ?? 'local-failsafe', doneAt: Math.max(...yellow.map((g) => (this.yellowSince[g] ?? now) + this.localYellowMs)) };
  }

  heartbeat(now: number) {
    if (this.faults.offline) return null;
    let aspects = { ...this.aspects };
    if (this.faults.unsafeHeartbeat) aspects = Object.fromEntries(this.groups.map((g) => [g, 'GREEN' as Aspect]));
    return { type: 'HEARTBEAT' as const, junction_id: this.junctionId, aspects, last_applied_command_id: this.lastAppliedCommandId, health: 'OK', controller_ts: now };
  }

  private apply(next: AspectVector, now: number) {
    for (const g of this.groups) {
      if (this.aspects[g] !== 'YELLOW' && next[g] === 'YELLOW') this.yellowSince[g] = now;
    }
    const wasAllRed = this.groups.every((g) => this.aspects[g] === 'RED');
    this.aspects = { ...next };
    const isAllRed = this.groups.every((g) => this.aspects[g] === 'RED');
    if (isAllRed && !wasAllRed) this.allRedSince = now;
  }
}
