import { VEHICLE_TYPES } from './types.js';

export interface JunctionConfig {
  junctionId: string;
  name: string;
  version: number;
  approaches: string[];
  signalGroups: { id: string; approach: string }[];
  phases: { id: string; signalGroups: string[] }[];
  conflicts: [string, string][];
  timings: { greenBlockS: number; minGreenS: number; maxGreenS: number; yellowS: number; allRedS: number };
  scheduling: { weights: Record<string, number>; agingS: number; hysteresis: number; starvationS: number; recallWeight: number };
  emergency: { staleAfterS: number; holdTimeoutS: number; absoluteCapS: number; contestedSliceS: number; maxActive: number; cancelCooldownS: number };
  manual: { leaseS: number; maxLeaseS: number };
  queue: { capacityPerApproach: number; entryTtlS: number; staleArrivalS: number; tombstoneTtlS: number };
  controller: {
    ackTimeoutMs: number; maxRetries: number; commandTtlMs: number; safeStopTtlMs: number;
    heartbeatIntervalS: number; missedHeartbeats: number; recoveryTimeoutS: number;
  };
}

export interface CompiledConfig {
  raw: JunctionConfig;
  junctionId: string;
  groupIds: string[];
  approaches: string[];
  phases: { id: string; groups: Set<string>; approaches: string[] }[];
  conflicts: [string, string][];
  ms: {
    greenBlock: number; minGreen: number; maxGreen: number; yellow: number; allRed: number; aging: number; starvation: number;
    staleEmergency: number; emergencyHold: number; emergencyCap: number; contestedSlice: number; cancelCooldown: number;
    lease: number; maxLease: number; entryTtl: number; staleArrival: number; tombstoneTtl: number;
    ackTimeout: number; commandTtl: number; safeStopTtl: number; heartbeatTimeout: number; safeStopRetryGap: number;
  };
}

const ID = /^[A-Z0-9_-]{1,32}$/;

/** Returns every violation of rules V-1..V-8 (plan §3.2). An empty array means the config is valid. */
export function validateConfig(c: JunctionConfig): string[] {
  const e: string[] = [];
  if (!/^[A-Z0-9_-]{1,16}$/.test(c.junctionId)) e.push('V-1 junction_id malformed');
  const uniq = (xs: string[], what: string) => {
    if (new Set(xs).size !== xs.length) e.push(`V-1 duplicate ${what}`);
    for (const x of xs) if (!ID.test(x)) e.push(`V-1 bad id ${x}`);
  };
  uniq(c.approaches, 'approach');
  uniq(c.signalGroups.map((g) => g.id), 'signal group');
  uniq(c.phases.map((p) => p.id), 'phase');
  if (c.phases.length < 2) e.push('V-1 at least two phases required');

  const groups = new Set(c.signalGroups.map((g) => g.id));
  for (const g of c.signalGroups) if (!c.approaches.includes(g.approach)) e.push(`V-2 group ${g.id} references unknown approach ${g.approach}`);
  for (const a of c.approaches) if (!c.signalGroups.some((g) => g.approach === a)) e.push(`V-2 approach ${a} has no signal group`);

  const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const conflict = new Set<string>();
  for (const [a, b] of c.conflicts) {
    if (!groups.has(a) || !groups.has(b)) e.push(`V-5 conflict ${a}/${b} references unknown group`);
    if (a === b) e.push(`V-5 self conflict ${a}`);
    conflict.add(key(a, b));
  }
  for (const p of c.phases) {
    for (const g of p.signalGroups) if (!groups.has(g)) e.push(`V-1 phase ${p.id} references unknown group ${g}`);
    for (const a of p.signalGroups) {
      for (const b of p.signalGroups) {
        if (a < b && conflict.has(key(a, b))) e.push(`V-3 phase ${p.id} contains conflicting groups ${a}/${b}`);
      }
    }
  }
  for (const g of groups) if (!c.phases.some((p) => p.signalGroups.includes(g))) e.push(`V-4 group ${g} is in no phase, so its approach would starve`);
  const ids = [...groups];
  for (const a of ids) {
    for (const b of ids) {
      if (a >= b) continue;
      const share = c.phases.some((p) => p.signalGroups.includes(a) && p.signalGroups.includes(b));
      if (!share && !conflict.has(key(a, b))) e.push(`V-6 groups ${a}/${b} never share a phase but are not declared conflicting`);
    }
  }
  const t = c.timings;
  if (!(t.yellowS >= 3 && t.yellowS <= 10)) e.push('V-7 yellow must be 3..10 s');
  if (!(t.allRedS >= 1 && t.allRedS <= 10)) e.push('V-7 all-red must be 1..10 s');
  if (!(t.minGreenS >= 5 && t.minGreenS <= t.greenBlockS && t.greenBlockS <= t.maxGreenS && t.maxGreenS <= 300)) {
    e.push('V-7 need 5 <= min green <= green block <= max green <= 300');
  }
  if (c.controller.ackTimeoutMs < 500) e.push('V-7 ack timeout must be >= 500 ms');
  if (c.controller.recoveryTimeoutS < t.yellowS + 2) e.push('V-7 recovery timeout must be >= yellow + 2 s');
  for (const v of VEHICLE_TYPES) if (!((c.scheduling.weights[v] ?? 0) > 0)) e.push(`V-8 missing positive weight for ${v}`);
  if (c.scheduling.hysteresis < 1) e.push('V-8 hysteresis must be >= 1');
  if (c.scheduling.starvationS <= t.maxGreenS) e.push('V-8 starvation limit must exceed max green');
  return e;
}

export function compileConfig(c: JunctionConfig): CompiledConfig {
  const errors = validateConfig(c);
  if (errors.length) throw new Error(`Invalid junction config ${c.junctionId}: ${errors.join('; ')}`);
  const approachOfGroup = Object.fromEntries(c.signalGroups.map((g) => [g.id, g.approach]));
  const s = 1000;
  return {
    raw: c,
    junctionId: c.junctionId,
    groupIds: c.signalGroups.map((g) => g.id),
    approaches: c.approaches,
    phases: c.phases.map((p) => ({
      id: p.id,
      groups: new Set(p.signalGroups),
      approaches: [...new Set(p.signalGroups.map((g) => approachOfGroup[g]!))],
    })),
    conflicts: c.conflicts,
    ms: {
      greenBlock: c.timings.greenBlockS * s, minGreen: c.timings.minGreenS * s, maxGreen: c.timings.maxGreenS * s,
      yellow: c.timings.yellowS * s, allRed: c.timings.allRedS * s, aging: c.scheduling.agingS * s,
      starvation: c.scheduling.starvationS * s, staleEmergency: c.emergency.staleAfterS * s,
      emergencyHold: c.emergency.holdTimeoutS * s, emergencyCap: c.emergency.absoluteCapS * s,
      contestedSlice: c.emergency.contestedSliceS * s, cancelCooldown: c.emergency.cancelCooldownS * s,
      lease: c.manual.leaseS * s, maxLease: c.manual.maxLeaseS * s, entryTtl: c.queue.entryTtlS * s,
      staleArrival: c.queue.staleArrivalS * s, tombstoneTtl: c.queue.tombstoneTtlS * s,
      ackTimeout: c.controller.ackTimeoutMs, commandTtl: c.controller.commandTtlMs, safeStopTtl: c.controller.safeStopTtlMs,
      heartbeatTimeout: c.controller.heartbeatIntervalS * c.controller.missedHeartbeats * s, safeStopRetryGap: 30 * s,
    },
  };
}

/** Maps the snake_case JSON used by config files and the API to the domain config. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function configFromJson(j: any): JunctionConfig {
  return {
    junctionId: j.junction_id, name: j.name, version: j.version, approaches: j.approaches,
    signalGroups: j.signal_groups,
    phases: j.phases.map((p: { id: string; signal_groups: string[] }) => ({ id: p.id, signalGroups: p.signal_groups })),
    conflicts: j.conflicts,
    timings: {
      greenBlockS: j.timings.green_block_s, minGreenS: j.timings.min_green_s, maxGreenS: j.timings.max_green_s,
      yellowS: j.timings.yellow_s, allRedS: j.timings.all_red_s,
    },
    scheduling: {
      weights: j.scheduling.weights, agingS: j.scheduling.aging_s, hysteresis: j.scheduling.hysteresis,
      starvationS: j.scheduling.starvation_s, recallWeight: j.scheduling.recall_weight,
    },
    emergency: {
      staleAfterS: j.emergency.stale_after_s, holdTimeoutS: j.emergency.hold_timeout_s, absoluteCapS: j.emergency.absolute_cap_s,
      contestedSliceS: j.emergency.contested_slice_s, maxActive: j.emergency.max_active, cancelCooldownS: j.emergency.cancel_cooldown_s,
    },
    manual: { leaseS: j.manual.lease_s, maxLeaseS: j.manual.max_lease_s },
    queue: {
      capacityPerApproach: j.queue.capacity_per_approach, entryTtlS: j.queue.entry_ttl_s,
      staleArrivalS: j.queue.stale_arrival_s, tombstoneTtlS: j.queue.tombstone_ttl_s,
    },
    controller: {
      ackTimeoutMs: j.controller.ack_timeout_ms, maxRetries: j.controller.max_retries, commandTtlMs: j.controller.command_ttl_ms,
      safeStopTtlMs: j.controller.safe_stop_ttl_ms, heartbeatIntervalS: j.controller.heartbeat_interval_s,
      missedHeartbeats: j.controller.missed_heartbeats, recoveryTimeoutS: j.controller.recovery_timeout_s,
    },
  };
}
