import type { CompiledConfig } from './config.js';
import type { Instant, JunctionState } from './types.js';

export interface PhaseScore { phase: string; score: number; demand: number; oldestWaitMs: number }

/** score(phase) = Σ weight(type) × (1 + wait/aging), plus recall for approaches with an offline sensor (plan §4.3). */
export function scorePhases(cfg: CompiledConfig, s: JunctionState, now: Instant): PhaseScore[] {
  const w = cfg.raw.scheduling.weights;
  return cfg.phases.map((p) => {
    let score = 0;
    let demand = 0;
    let oldest = 0;
    for (const a of p.approaches) {
      for (const v of s.queues[a] ?? []) {
        const wait = Math.max(0, now - v.queuedAt);
        score += (w[v.type] ?? 1) * (1 + wait / cfg.ms.aging);
        demand++;
        oldest = Math.max(oldest, wait);
      }
      if (s.faults.some((f) => f.code === 'SENSOR_OFFLINE' && f.subject === a)) {
        const since = Math.max(0, now - (s.lastServedAt[p.id] ?? now));
        score += cfg.raw.scheduling.recallWeight * (1 + since / cfg.ms.aging);
        demand++;
        oldest = Math.max(oldest, since);
      }
    }
    return { phase: p.id, score: Math.round(score * 1000) / 1000, demand, oldestWaitMs: oldest };
  });
}

/** Phase choice at the end of ALL_RED in AUTOMATIC mode: starvation, then best score, then least recently served. */
export function chooseFromAllRed(cfg: CompiledConfig, s: JunctionState, now: Instant): { phase: string; rule: string; scores: PhaseScore[] } {
  const scores = scorePhases(cfg, s, now);
  const starving = scores
    .filter((x) => x.demand > 0 && x.oldestWaitMs >= cfg.ms.starvation)
    .sort((a, b) => b.oldestWaitMs - a.oldestWaitMs);
  if (starving[0]) return { phase: starving[0].phase, rule: 'STARVATION', scores };
  const withDemand = scores.filter((x) => x.demand > 0);
  if (withDemand.length > 0) {
    const best = withDemand.reduce((a, b) => (b.score > a.score ? b : a));
    return { phase: best.phase, rule: 'SCORE', scores };
  }
  const lru = [...cfg.phases].sort((a, b) => (s.lastServedAt[a.id] ?? 0) - (s.lastServedAt[b.id] ?? 0))[0]!;
  return { phase: lru.id, rule: 'REST', scores };
}
