/** Thin API client. The dashboard only renders backend state and sends intents (spec §14). */
export interface Problem { status: number; code: string; detail?: string; errors?: { path: string; message: string }[] }

export class ApiError extends Error {
  constructor(public readonly problem: Problem) { super(problem.detail ?? problem.code); }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? 'GET',
      credentials: 'same-origin',
      headers: {
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(init.method && init.method !== 'GET' ? { 'x-ftms-request': '1' } : {}),
        ...init.headers,
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch {
    throw new ApiError({ status: 0, code: 'BACKEND_UNREACHABLE', detail: 'The backend could not be reached.' });
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new ApiError({ status: res.status, code: data?.code ?? `HTTP_${res.status}`, detail: data?.detail, errors: data?.errors });
  return data as T;
}

export type Aspect = 'RED' | 'YELLOW' | 'GREEN' | 'UNKNOWN';

export interface Status {
  junction_id: string;
  version: number;
  mode: string;
  control_mode: string;
  health: string;
  controller_status: string;
  phase: string;
  interval: { kind: string; phase: string | null; since: string | null; ends_at: string | null };
  desired_signals: Record<string, Aspect>;
  actual_signals: Record<string, Aspect>;
  actual_known: boolean;
  actual_confirmed_at: string | null;
  pending_command: { command_id: string; kind: string; step: string; phase: string | null; attempt: number; ack_deadline_at: string } | null;
  queues: Record<string, number>;
  queue_details: Record<string, { count: number; by_type: Record<string, number>; oldest_wait_s: number }>;
  emergencies: { vehicle_id: string; direction: string; phase: string; source: string; detected_at: string; expires_at: string }[];
  manual: { target_phase: string; by: string; reason: string; lease_expires_at: string } | null;
  hold: { by: string; reason: string; since: string } | null;
  faults: { code: string; subject: string | null; since: string; detail: string | null }[];
  alerts: { code: string; severity: string; message: string }[];
  allowed_commands: string[];
  server_time: string;
}

export interface Me { username: string; role: string; simulation_allowed: boolean; simulation_mode: boolean }

export interface AuditEntry {
  chain_seq: number; occurred_at: string; event_type: string; severity: string; actor_type: string; actor_id: string | null;
  correlation_id: string | null; direction: string | null; previous_state: unknown; new_state: unknown; details: Record<string, unknown>;
}
