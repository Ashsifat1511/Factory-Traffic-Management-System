import { decide, type CompiledConfig, type Decision, type Input, type JunctionState, type Outcome } from '@ftms/domain';
import type { CommitMeta } from '../adapters/postgres/store.js';

export class JunctionBusy extends Error {}

export interface ActorDeps {
  now(): number;
  newId(prefix: string): string;
  commit(prev: JunctionState, d: Decision, meta: CommitMeta, at: Date): Promise<void>;
  /** Runs effects after a successful commit. Never blocks the actor. */
  runEffects(junctionId: string, d: Decision): void;
  published(state: JunctionState, d: Decision): void;
}

interface Envelope {
  input: Input;
  meta: CommitMeta;
  /** Optional pre-check run inside the actor (e.g. duplicate detection) that can answer without deciding. */
  precheck?: () => Promise<Outcome | null>;
  resolve: (o: Outcome) => void;
  reject: (e: unknown) => void;
}

/**
 * One actor per junction (plan §10.1): every input is processed strictly one at a time,
 * so concurrent requests can never produce conflicting decisions.
 */
export class JunctionActor {
  private mailbox: Envelope[] = [];
  private running = false;

  constructor(public config: CompiledConfig, private state: JunctionState, private readonly deps: ActorDeps, private readonly capacity = 1000) {}

  get snapshot(): JunctionState { return this.state; }

  submit(input: Input, meta: CommitMeta, precheck?: Envelope['precheck'], timeoutMs = 5000): Promise<Outcome> {
    if (this.mailbox.length >= this.capacity) return Promise.reject(new JunctionBusy('mailbox full'));
    return new Promise<Outcome>((resolve, reject) => {
      const timer = setTimeout(() => reject(new JunctionBusy('timeout')), timeoutMs);
      this.mailbox.push({
        input, meta, ...(precheck ? { precheck } : {}),
        resolve: (o) => { clearTimeout(timer); resolve(o); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      void this.pump();
    });
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      for (let env = this.mailbox.shift(); env; env = this.mailbox.shift()) {
        try {
          const early = env.precheck ? await env.precheck() : null;
          if (early) { env.resolve(early); continue; }
          const now = this.deps.now();
          const decision = decide({ config: this.config, now, newId: this.deps.newId }, this.state, env.input);
          if (decision.state !== this.state) {
            await this.deps.commit(this.state, decision, env.meta, new Date(now));
            this.state = decision.state; // only after a successful commit
            this.deps.runEffects(this.state.junctionId, decision);
            this.deps.published(this.state, decision);
          }
          env.resolve(decision.outcome);
        } catch (e) {
          env.reject(e);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
