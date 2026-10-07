import type { AuditRecord, Decision, JunctionConfig, JunctionState } from '@ftms/domain';
import { canonical, sha256, type ActorType, type CommitMeta, type JunctionStore } from '../../application/ports.js';
import { tx, type Client, type Pool } from './db.js';

export { canonical, sha256, type ActorType, type CommitMeta };

export class ConcurrencyError extends Error {}

const ZERO = Buffer.alloc(32);

export interface AuditRow {
  chain_id: string; chain_seq: number; occurred_at: string; junction_id: string | null; event_type: string;
  severity: string; actor_type: string; actor_id: string | null; correlation_id: string | null; direction: string | null;
  previous_state: unknown; new_state: unknown; details: unknown;
}
export const auditHash = (prev: Buffer, row: AuditRow) => sha256(Buffer.concat([prev, Buffer.from(canonical(row))]));

/** Appends audit records to a hash chain inside the caller's transaction (plan §11.4). */
export async function appendAudit(c: Client, chainId: string, junctionId: string | null, records: AuditRecord[], at: Date, actorType: ActorType, actorId?: string) {
  if (records.length === 0) return;
  await c.query('INSERT INTO audit_chain_heads (chain_id, last_seq, last_hash) VALUES ($1, 0, $2) ON CONFLICT DO NOTHING', [chainId, ZERO]);
  const head = (await c.query('SELECT last_seq, last_hash FROM audit_chain_heads WHERE chain_id = $1 FOR UPDATE', [chainId])).rows[0];
  let seq = Number(head.last_seq);
  let prev: Buffer = head.last_hash;
  for (const r of records) {
    seq += 1;
    const row: AuditRow = {
      chain_id: chainId, chain_seq: seq, occurred_at: at.toISOString(), junction_id: junctionId, event_type: r.type,
      severity: r.severity, actor_type: actorType, actor_id: actorId ?? null, correlation_id: r.correlationId ?? null,
      direction: r.direction ?? null, previous_state: r.previous ?? null, new_state: r.next ?? null, details: r.details ?? {},
    };
    const hash = auditHash(prev, row);
    await c.query(
      `INSERT INTO audit_log (chain_id, chain_seq, occurred_at, junction_id, event_type, severity, actor_type, actor_id,
        correlation_id, direction, previous_state, new_state, details, prev_hash, hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [chainId, seq, at, junctionId, r.type, r.severity, actorType, row.actor_id, row.correlation_id, row.direction,
        JSON.stringify(row.previous_state), JSON.stringify(row.new_state), JSON.stringify(row.details), prev, hash],
    );
    prev = hash;
  }
  await c.query('UPDATE audit_chain_heads SET last_seq = $2, last_hash = $3 WHERE chain_id = $1', [chainId, seq, prev]);
}

export class Store implements JunctionStore {
  constructor(private readonly pool: Pool) {}

  async loadJunctions(): Promise<{ config: JunctionConfig; state: JunctionState | null; epoch: number }[]> {
    const { rows } = await this.pool.query(
      `SELECT c.config, s.state, s.epoch FROM junctions j
       JOIN junction_configs c ON c.junction_id = j.junction_id AND c.version = j.active_config_version
       LEFT JOIN junction_state s ON s.junction_id = j.junction_id ORDER BY j.junction_id`,
    );
    return rows.map((r) => ({ config: r.config, state: r.state, epoch: r.epoch ?? 0 }));
  }

  async createJunction(config: JunctionConfig, by: string): Promise<boolean> {
    return tx(this.pool, async (c) => {
      const exists = await c.query('SELECT 1 FROM junctions WHERE junction_id = $1', [config.junctionId]);
      if (exists.rowCount) return false;
      await c.query('INSERT INTO junctions (junction_id, name, active_config_version, created_by) VALUES ($1,$2,$3,$4)', [config.junctionId, config.name, config.version, by]);
      await c.query('INSERT INTO junction_configs (junction_id, version, config, created_by) VALUES ($1,$2,$3,$4)', [config.junctionId, config.version, JSON.stringify(config), by]);
      await appendAudit(c, config.junctionId, config.junctionId, [{ type: 'CONFIG_CREATED', severity: 'INFO', details: { version: config.version } }], new Date(), 'OPERATOR', by);
      return true;
    });
  }

  /** Increments and returns the fencing epoch for a junction (startup step 4). */
  async bumpEpoch(junctionId: string): Promise<number> {
    const { rows } = await this.pool.query(
      `INSERT INTO junction_state (junction_id, version, epoch, state) VALUES ($1, 0, 1, 'null'::jsonb)
       ON CONFLICT (junction_id) DO UPDATE SET epoch = junction_state.epoch + 1 RETURNING epoch`, [junctionId]);
    return rows[0].epoch;
  }

  async findProcessed(sourceId: string, eventId: string): Promise<{ payloadHash: Buffer; outcome: unknown } | null> {
    const { rows } = await this.pool.query('SELECT payload_hash, outcome FROM processed_events WHERE source_id = $1 AND event_id = $2', [sourceId, eventId]);
    return rows[0] ? { payloadHash: rows[0].payload_hash, outcome: rows[0].outcome } : null;
  }

  async findOperatorRequest(user: string, key: string): Promise<unknown | null> {
    const { rows } = await this.pool.query('SELECT outcome FROM operator_requests WHERE requested_by = $1 AND idempotency_key = $2', [user, key]);
    return rows[0]?.outcome ?? null;
  }

  async commandExists(commandId: string, junctionId: string): Promise<'NONE' | 'OTHER_JUNCTION' | 'KNOWN'> {
    const { rows } = await this.pool.query('SELECT junction_id FROM controller_commands WHERE command_id = $1', [commandId]);
    if (!rows[0]) return 'NONE';
    return rows[0].junction_id === junctionId ? 'KNOWN' : 'OTHER_JUNCTION';
  }

  /** One transaction per decision (plan §10.2): snapshot with version check, command ledger, dedupe row, audit. */
  async commit(prev: JunctionState, decision: Decision, meta: CommitMeta, at: Date): Promise<void> {
    const next = decision.state;
    await tx(this.pool, async (c) => {
      const res = await c.query(
        'UPDATE junction_state SET version = $2, state = $3, epoch = $5, updated_at = now() WHERE junction_id = $1 AND (version = $4 OR state = \'null\'::jsonb)',
        [next.junctionId, next.version, JSON.stringify(next), prev.version, next.epoch],
      );
      if (res.rowCount !== 1) throw new ConcurrencyError(`junction ${next.junctionId} was changed by another writer`);

      const p = prev.pending;
      const n = next.pending;
      if (p && p.commandId !== n?.commandId) {
        const t = decision.audit.filter((a) => a.correlationId === p.commandId).map((a) => a.type);
        const status = next.lastAckedCommandId === p.commandId ? 'ACKED'
          : t.includes('CONTROLLER_NACK') ? 'NACKED'
          : t.includes('CONTROLLER_TIMEOUT') ? 'TIMED_OUT'
          : t.includes('COMMAND_ABANDONED') ? 'ABANDONED'
          : t.includes('CONTROLLER_ACK') ? 'MISMATCH' : 'SUPERSEDED';
        await c.query('UPDATE controller_commands SET status = $2, resolved_at = $3 WHERE command_id = $1 AND status = \'PENDING\'', [p.commandId, status, at]);
      }
      if (n && n.commandId !== p?.commandId) {
        await c.query(
          `INSERT INTO controller_commands (command_id, junction_id, seq, epoch, kind, step, phase, target_aspects, cause, status, attempts, issued_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'PENDING',$10,$11)`,
          [n.commandId, next.junctionId, n.seq, n.epoch, n.kind, n.step, n.phase, JSON.stringify(n.target), n.cause, n.attempt, new Date(n.issuedAt)],
        );
      } else if (n && p && n.attempt !== p.attempt) {
        await c.query('UPDATE controller_commands SET attempts = $2 WHERE command_id = $1', [n.commandId, n.attempt]);
      }
      if (meta.processedEvent && decision.outcome.ok) { // rejected events never burn an event_id
        await c.query(
          'INSERT INTO processed_events (source_id, event_id, junction_id, payload_hash, outcome, received_at) VALUES ($1,$2,$3,$4,$5,$6)',
          [meta.processedEvent.sourceId, meta.processedEvent.eventId, next.junctionId, meta.processedEvent.payloadHash, JSON.stringify(decision.outcome), at],
        );
      }
      if (meta.operatorRequest) {
        const o = meta.operatorRequest;
        await c.query(
          'INSERT INTO operator_requests (request_id, junction_id, command, payload, requested_by, idempotency_key, outcome, received_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [o.requestId, next.junctionId, o.command, JSON.stringify(o.payload), o.requestedBy, o.idempotencyKey ?? null, JSON.stringify(decision.outcome), at],
        );
      }
      await appendAudit(c, next.junctionId, next.junctionId, decision.audit, at, meta.actorType, meta.actorId);
    });
  }

  async audit(chainId: string, junctionId: string | null, records: AuditRecord[], actorType: ActorType, actorId?: string) {
    await tx(this.pool, (c) => appendAudit(c, chainId, junctionId, records, new Date(), actorType, actorId));
  }

  async reject(entry: { channel?: 'HTTP' | 'MQTT'; endpoint: string; sourceId?: string; remoteAddr?: string; reasonCode: string; detail?: string; payload?: unknown }) {
    const payload = entry.payload === undefined ? null : JSON.stringify(entry.payload).slice(0, 4096);
    await this.pool.query(
      'INSERT INTO rejected_events (channel, endpoint, source_id, remote_addr, reason_code, detail, payload) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [entry.channel ?? 'HTTP', entry.endpoint, entry.sourceId ?? null, entry.remoteAddr ?? null, entry.reasonCode, entry.detail ?? null, payload && JSON.stringify({ raw: payload })],
    );
  }

  async history(junctionId: string, opts: { limit: number; before?: number; type?: string; direction?: string; from?: Date; to?: Date }) {
    const params: unknown[] = [junctionId, opts.limit];
    let where = 'chain_id = $1';
    if (opts.before) { params.push(opts.before); where += ` AND chain_seq < $${params.length}`; }
    if (opts.type) { params.push(opts.type); where += ` AND event_type = $${params.length}`; }
    if (opts.direction) { params.push(opts.direction); where += ` AND direction = $${params.length}`; }
    if (opts.from) { params.push(opts.from); where += ` AND occurred_at >= $${params.length}`; }
    if (opts.to) { params.push(opts.to); where += ` AND occurred_at < $${params.length}`; }
    const { rows } = await this.pool.query(
      `SELECT audit_id, chain_seq, occurred_at, event_type, severity, actor_type, actor_id, correlation_id, direction, previous_state, new_state, details
       FROM audit_log WHERE ${where} ORDER BY chain_seq DESC LIMIT $2`, params);
    return rows;
  }

  /** Audit entries after a chain position, oldest first: feeds SSE and `Last-Event-ID` replay (plan §12.4). */
  async auditAfter(chainId: string, afterSeq: number, limit = 500) {
    const { rows } = await this.pool.query(
      `SELECT chain_seq, occurred_at, event_type, severity, actor_type, actor_id, correlation_id, direction, previous_state, new_state, details
       FROM audit_log WHERE chain_id = $1 AND chain_seq > $2 ORDER BY chain_seq LIMIT $3`, [chainId, afterSeq, limit]);
    return rows.map((r) => ({ ...r, chain_seq: Number(r.chain_seq) }));
  }

  async lastSeq(chainId: string): Promise<number> {
    const { rows } = await this.pool.query('SELECT last_seq FROM audit_chain_heads WHERE chain_id = $1', [chainId]);
    return Number(rows[0]?.last_seq ?? 0);
  }

  /** Recomputes a hash chain; returns the first broken chain_seq or null when intact. */
  async verifyChain(chainId: string): Promise<{ checked: number; brokenAt: number | null }> {
    const { rows } = await this.pool.query('SELECT * FROM audit_log WHERE chain_id = $1 ORDER BY chain_seq', [chainId]);
    let prev = ZERO;
    for (const r of rows) {
      const row: AuditRow = {
        chain_id: r.chain_id, chain_seq: Number(r.chain_seq), occurred_at: new Date(r.occurred_at).toISOString(), junction_id: r.junction_id,
        event_type: r.event_type, severity: r.severity, actor_type: r.actor_type, actor_id: r.actor_id, correlation_id: r.correlation_id,
        direction: r.direction, previous_state: r.previous_state, new_state: r.new_state, details: r.details,
      };
      if (!prev.equals(r.prev_hash) || !auditHash(prev, row).equals(r.hash)) return { checked: rows.length, brokenAt: row.chain_seq };
      prev = r.hash;
    }
    return { checked: rows.length, brokenAt: null };
  }

  async purge(): Promise<void> {
    await this.pool.query("DELETE FROM processed_events WHERE received_at < now() - interval '30 days'");
    await this.pool.query("DELETE FROM rejected_events WHERE received_at < now() - interval '30 days'");
  }
}
