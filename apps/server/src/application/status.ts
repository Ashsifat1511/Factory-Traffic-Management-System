import { allowedCommands, controlMode, health, specMode, type CompiledConfig, type JunctionState } from '@ftms/domain';

const iso = (t: number | null | undefined) => (t == null ? null : new Date(t).toISOString());

/** The status resource (plan §12.3), a superset of spec §10.3. */
export function statusView(cfg: CompiledConfig, s: JunctionState, now: number) {
  const iv = s.interval;
  const byApproach = (v: Record<string, string> | null) =>
    Object.fromEntries(cfg.approaches.map((a) => [a, v ? (v[a] ?? 'UNKNOWN') : 'UNKNOWN']));
  const h = health(s);
  const controllerStatus = s.controller.link === 'OFFLINE' ? 'OFFLINE'
    : !s.controller.commissioned || s.controller.link === 'UNKNOWN' ? 'UNKNOWN'
    : s.faults.some((f) => ['CONTROLLER_UNRESPONSIVE', 'COMMAND_REJECTED', 'STATE_MISMATCH', 'SIGNAL_HEAD_FAULT', 'UNSAFE_STATE_REPORTED'].includes(f.code)) ? 'DEGRADED'
    : 'ONLINE';
  let endsAt: number | null = null;
  if (iv.kind === 'YELLOW') endsAt = iv.since + cfg.ms.yellow;
  if (iv.kind === 'ALL_RED') endsAt = iv.since + cfg.ms.allRed;
  return {
    junction_id: s.junctionId,
    version: s.version,
    mode: specMode(s, now),
    control_mode: controlMode(s, now),
    health: h,
    controller_status: controllerStatus,
    phase: iv.kind === 'GREEN' || iv.kind === 'YELLOW' ? iv.phase : iv.kind === 'ALL_RED' ? 'ALL_RED' : 'UNKNOWN',
    interval: { kind: iv.kind, phase: 'phase' in iv ? iv.phase : null, since: iso('since' in iv ? iv.since : null), ends_at: iso(endsAt) },
    desired_signals: byApproach(s.desired),
    actual_signals: byApproach(s.confirmed?.aspects ?? null),
    actual_known: s.confirmed !== null && iv.kind !== 'UNKNOWN',
    actual_confirmed_at: iso(s.confirmed?.at),
    pending_command: s.pending && {
      command_id: s.pending.commandId, kind: s.pending.kind, step: s.pending.step, phase: s.pending.phase,
      attempt: s.pending.attempt, ack_deadline_at: iso(s.pending.ackDeadline),
    },
    queues: Object.fromEntries(cfg.approaches.map((a) => [a, (s.queues[a] ?? []).length])),
    queue_details: Object.fromEntries(cfg.approaches.map((a) => {
      const list = s.queues[a] ?? [];
      const byType: Record<string, number> = {};
      for (const v of list) byType[v.type] = (byType[v.type] ?? 0) + 1;
      const oldest = list.reduce((m, v) => Math.min(m, v.queuedAt), Infinity);
      return [a, { count: list.length, by_type: byType, oldest_wait_s: list.length ? Math.round((now - oldest) / 1000) : 0 }];
    })),
    emergencies: s.emergencies.map((e) => ({
      vehicle_id: e.vehicleId, direction: e.approach, phase: e.phase, source: e.source,
      detected_at: iso(e.detectedAt), expires_at: iso(e.expiresAt),
    })),
    manual: s.manual && { target_phase: s.manual.phase, by: s.manual.by, reason: s.manual.reason, lease_expires_at: iso(s.manual.leaseExpiresAt) },
    hold: s.hold && { by: s.hold.by, reason: s.hold.reason, since: iso(s.hold.since) },
    faults: s.faults.map((f) => ({ code: f.code, subject: f.subject ?? null, since: iso(f.since), detail: f.detail ?? null })),
    alerts: alertsOf(s, now),
    allowed_commands: allowedCommands(s, now),
    server_time: iso(now),
  };
}

/** Active alerts derived from state (condition alerts clear themselves when the condition clears). */
function alertsOf(s: JunctionState, now: number) {
  const out: { code: string; severity: string; message: string }[] = [];
  for (const f of s.faults) {
    const critical = f.code === 'UNSAFE_STATE_REPORTED' || f.code === 'SAFETY_GUARD_TRIPPED';
    const warning = !['STATE_UNKNOWN'].includes(f.code);
    out.push({ code: f.code, severity: critical ? 'CRITICAL' : warning ? 'WARNING' : 'INFO', message: `${f.code}${f.subject ? ` (${f.subject})` : ''}${f.detail ? `: ${f.detail}` : ''}` });
  }
  for (const e of s.emergencies) out.push({ code: 'EMERGENCY_ACTIVE', severity: 'WARNING', message: `Emergency vehicle ${e.vehicleId} from ${e.approach}` });
  if (s.emergencies.length && (health(s) === 'FAILED' || health(s) === 'UNKNOWN')) out.push({ code: 'PREEMPTION_UNAVAILABLE', severity: 'CRITICAL', message: 'Emergency waiting but the controller state is not confirmed safe' });
  if (s.hold && s.emergencies.length) out.push({ code: 'EMERGENCY_BLOCKED_BY_HOLD', severity: 'CRITICAL', message: 'Emergency waiting at a held junction' });
  if (new Set(s.emergencies.map((e) => e.phase)).size > 1) out.push({ code: 'EMERGENCY_CONFLICT', severity: 'CRITICAL', message: 'Emergencies from conflicting directions' });
  if (s.pending && s.pending.attempt > 1) out.push({ code: 'COMMAND_TIMEOUT', severity: 'WARNING', message: `No ACK yet for ${s.pending.commandId} (attempt ${s.pending.attempt})` });
  if (s.pending === null && s.confirmed && Object.keys(s.desired).some((g) => s.desired[g] !== s.confirmed!.aspects[g])) out.push({ code: 'DESIRED_ACTUAL_MISMATCH', severity: 'WARNING', message: 'Desired and confirmed signals differ' });
  for (const list of Object.values(s.queues)) {
    if (list.some((v) => now - v.queuedAt > 120_000)) { out.push({ code: 'STARVATION_WARNING', severity: 'WARNING', message: 'A vehicle has waited more than 120 s' }); break; }
  }
  return out;
}
