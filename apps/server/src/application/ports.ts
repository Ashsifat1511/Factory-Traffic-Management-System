import { createHash } from 'node:crypto';
import type { AuditRecord, Decision, JunctionConfig, JunctionState } from '@ftms/domain';

/** Ports of the application layer (plan §2.3). Adapters implement them; the application never imports adapters. */

export type ActorType = 'SYSTEM' | 'SCHEDULER' | 'OPERATOR' | 'DEVICE' | 'SIMULATOR';

export interface CommitMeta {
  actorType: ActorType;
  actorId?: string;
  processedEvent?: { sourceId: string; eventId: string; payloadHash: Buffer };
  operatorRequest?: { requestId: string; command: string; payload: unknown; requestedBy: string; idempotencyKey?: string };
}

/** Persistence used by the runtime: one transaction per decision, de-duplication lookups and the audit trail. */
export interface JunctionStore {
  loadJunctions(): Promise<{ config: JunctionConfig; state: JunctionState | null; epoch: number }[]>;
  createJunction(config: JunctionConfig, by: string): Promise<boolean>;
  bumpEpoch(junctionId: string): Promise<number>;
  commit(prev: JunctionState, decision: Decision, meta: CommitMeta, at: Date): Promise<void>;
  findProcessed(sourceId: string, eventId: string): Promise<{ payloadHash: Buffer; outcome: unknown } | null>;
  findOperatorRequest(user: string, key: string): Promise<unknown | null>;
  commandExists(commandId: string, junctionId: string): Promise<'NONE' | 'OTHER_JUNCTION' | 'KNOWN'>;
  audit(chainId: string, junctionId: string | null, records: AuditRecord[], actorType: ActorType, actorId?: string): Promise<void>;
}

/** Sorted-key JSON, used for payload hashes and the audit hash chain. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest();
