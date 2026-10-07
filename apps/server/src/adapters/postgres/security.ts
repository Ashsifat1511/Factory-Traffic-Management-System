import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { sha256, type Store } from './store.js';
import type { Pool } from './db.js';

export type Role = 'VIEWER' | 'OPERATOR' | 'ADMIN';
export interface SessionUser { userId: string; username: string; role: Role; simulationAllowed: boolean }
export interface Device { deviceId: string; kind: 'SENSOR' | 'CONTROLLER'; junctionId: string; approach: string | null }

const IDLE_MS = 30 * 60_000;
const ABSOLUTE_MS = 12 * 3600_000;
const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

/** Operator accounts, server-side sessions and per-device keys (plan §14.4). */
export class Security {
  constructor(private readonly pool: Pool, private readonly pepper: string, private readonly store: Store) {}

  async createUser(username: string, password: string, role: Role, simulationAllowed = false) {
    if (password.length < 12) throw new Error('Password must be at least 12 characters');
    const hash = await argonHash(password, ARGON);
    await this.pool.query(
      `INSERT INTO users (user_id, username, password_hash, role, simulation_allowed) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, simulation_allowed = EXCLUDED.simulation_allowed`,
      [`usr-${randomBytes(6).toString('hex')}`, username, hash, role, simulationAllowed],
    );
  }

  async userExists(username: string): Promise<boolean> {
    return (await this.pool.query('SELECT 1 FROM users WHERE username = $1', [username])).rowCount! > 0;
  }

  /** Returns a session token, or null. Five failures lock the account for 15 minutes. */
  async login(username: string, password: string, ip: string, userAgent: string): Promise<{ token: string } | { error: 'INVALID' | 'LOCKED' }> {
    const { rows } = await this.pool.query('SELECT * FROM users WHERE username = $1 AND disabled_at IS NULL', [username]);
    const u = rows[0];
    if (!u) { await argonHash(password, ARGON); return { error: 'INVALID' }; } // equal timing for unknown users
    if (u.locked_until && new Date(u.locked_until) > new Date()) return { error: 'LOCKED' };
    if (!(await argonVerify(u.password_hash, password))) {
      const failures = u.failed_logins + 1;
      await this.pool.query('UPDATE users SET failed_logins = $2, locked_until = $3 WHERE user_id = $1',
        [u.user_id, failures >= 5 ? 0 : failures, failures >= 5 ? new Date(Date.now() + 15 * 60_000) : null]);
      await this.store.audit('SYSTEM', null, [{ type: 'SECURITY_EVENT', severity: 'SECURITY', details: { event: failures >= 5 ? 'ACCOUNT_LOCKED' : 'LOGIN_FAILED', username, ip } }], 'SYSTEM');
      return { error: 'INVALID' };
    }
    await this.pool.query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE user_id = $1', [u.user_id]);
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    await this.pool.query(
      'INSERT INTO sessions (session_hash, user_id, created_at, last_seen_at, expires_at, ip, user_agent) VALUES ($1,$2,$3,$3,$4,$5,$6)',
      [sha256(token), u.user_id, now, new Date(now.getTime() + ABSOLUTE_MS), ip, userAgent.slice(0, 200)],
    );
    return { token };
  }

  async session(token: string | undefined): Promise<SessionUser | null> {
    if (!token) return null;
    const { rows } = await this.pool.query(
      `SELECT s.last_seen_at, s.expires_at, u.user_id, u.username, u.role, u.simulation_allowed
       FROM sessions s JOIN users u ON u.user_id = s.user_id
       WHERE s.session_hash = $1 AND s.revoked_at IS NULL AND u.disabled_at IS NULL`, [sha256(token)]);
    const r = rows[0];
    const now = Date.now();
    if (!r || new Date(r.expires_at).getTime() < now || now - new Date(r.last_seen_at).getTime() > IDLE_MS) return null;
    await this.pool.query('UPDATE sessions SET last_seen_at = now() WHERE session_hash = $1', [sha256(token)]);
    return { userId: r.user_id, username: r.username, role: r.role, simulationAllowed: r.simulation_allowed };
  }

  async logout(token: string) {
    await this.pool.query('UPDATE sessions SET revoked_at = now() WHERE session_hash = $1', [sha256(token)]);
  }

  private keyHash(key: string) { return createHmac('sha256', this.pepper).update(key).digest(); }

  /** Creates a device key. The plain key is returned once and only its HMAC is stored. */
  async createDevice(deviceId: string, kind: Device['kind'], junctionId: string, approach: string | null, fixedKey?: string): Promise<string> {
    const prefix = randomBytes(4).toString('hex');
    const key = fixedKey ?? `ftms_dev_${prefix}_${randomBytes(32).toString('base64url')}`;
    const keyPrefix = key.split('_')[2] ?? prefix;
    await this.pool.query(
      `INSERT INTO devices (device_id, kind, junction_id, approach, key_prefix, key_hash, status) VALUES ($1,$2,$3,$4,$5,$6,'ACTIVE')
       ON CONFLICT (device_id) DO UPDATE SET key_prefix = EXCLUDED.key_prefix, key_hash = EXCLUDED.key_hash, status = 'ACTIVE'`,
      [deviceId, kind, junctionId, approach, keyPrefix, this.keyHash(key)],
    );
    return key;
  }

  async revokeDevice(deviceId: string) {
    await this.pool.query("UPDATE devices SET status = 'REVOKED' WHERE device_id = $1", [deviceId]);
  }

  async device(authorization: string | undefined): Promise<Device | null> {
    const key = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : null;
    const prefix = key?.split('_')[2];
    if (!key || !prefix) return null;
    const { rows } = await this.pool.query("SELECT * FROM devices WHERE key_prefix = $1 AND status = 'ACTIVE'", [prefix]);
    const d = rows[0];
    if (!d) return null;
    const expected: Buffer = d.key_hash;
    const actual = this.keyHash(key);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    void this.pool.query('UPDATE devices SET last_seen_at = now() WHERE device_id = $1', [d.device_id]);
    return { deviceId: d.device_id, kind: d.kind, junctionId: d.junction_id, approach: d.approach };
  }
}
