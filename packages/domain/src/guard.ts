import type { CompiledConfig } from './config.js';
import type { Aspect, AspectVector, Health, Instant } from './types.js';

export class UnsafeCommand extends Error {
  constructor(public readonly reason: string, public readonly details: Record<string, unknown> = {}) {
    super(`Unsafe command rejected by guard: ${reason}`);
  }
}

export const isPermissive = (a: Aspect | undefined) => a === 'GREEN' || a === 'YELLOW';

const LEGAL_NEXT: Record<Aspect, readonly Aspect[]> = {
  GREEN: ['GREEN', 'YELLOW'],
  YELLOW: ['YELLOW', 'RED'],
  RED: ['RED', 'GREEN'],
};

export interface GuardContext {
  now: Instant;
  confirmed: AspectVector | null;
  allRedConfirmedAt: Instant | null;
  health: Health;
  holdActive: boolean;
  commandPending: boolean;
}

/** Independent check of every outgoing SET_ASPECTS command (plan §3.4, invariants I-1..I-6). */
export function assertSafeCommand(cfg: CompiledConfig, next: AspectVector, ctx: GuardContext): void {
  for (const g of cfg.groupIds) if (!next[g]) throw new UnsafeCommand('MISSING_ASPECT', { g });
  for (const [a, b] of cfg.conflicts) {
    if (isPermissive(next[a]) && isPermissive(next[b])) throw new UnsafeCommand('CONFLICTING_PERMISSIVE', { a, b });
  }
  const permissive = cfg.groupIds.filter((g) => isPermissive(next[g]));
  if (permissive.length > 0 && !cfg.phases.some((p) => permissive.every((g) => p.groups.has(g)))) {
    throw new UnsafeCommand('NOT_A_SINGLE_PHASE', { permissive });
  }
  const last = ctx.confirmed;
  if (last === null) {
    if (permissive.length > 0) throw new UnsafeCommand('PHYSICAL_STATE_UNKNOWN');
    return;
  }
  for (const g of cfg.groupIds) {
    const from = last[g]!;
    if (!LEGAL_NEXT[from].includes(next[g]!)) throw new UnsafeCommand('ILLEGAL_STEP', { g, from, to: next[g] });
  }
  const turningGreen = cfg.groupIds.filter((g) => next[g] === 'GREEN' && last[g] !== 'GREEN');
  if (turningGreen.length > 0) {
    const cleared = ctx.allRedConfirmedAt !== null && ctx.now - ctx.allRedConfirmedAt >= cfg.ms.allRed;
    if (!cleared) throw new UnsafeCommand('CLEARANCE_NOT_MET');
    if (ctx.health === 'FAILED' || ctx.health === 'UNKNOWN' || ctx.holdActive || ctx.commandPending) {
      throw new UnsafeCommand('GREEN_NOT_ALLOWED_NOW', { health: ctx.health });
    }
  }
}

export function hasConflictingPermissive(cfg: CompiledConfig, v: AspectVector): boolean {
  return cfg.conflicts.some(([a, b]) => isPermissive(v[a]) && isPermissive(v[b]));
}
