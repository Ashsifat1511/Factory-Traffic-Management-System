import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mqtt, { type MqttClient } from 'mqtt';
import type { ZodTypeAny } from 'zod';
import type { ControllerGateway, Runtime, WireCommand } from '../../application/runtime.js';
import { ackSchema, deviceStatusSchema, heartbeatSchema, sensorEventSchema } from '../../contracts/schemas.js';
import { toAck, toDeviceStatus, toHeartbeat, toSensorEvent } from '../../contracts/ingest.js';
import type { Store } from '../postgres/store.js';

/** Topic layout (plan §13.1). */
export const topics = {
  backendStatus: 'ftms/v1/backend/status',
  commands: (j: string) => `ftms/v1/junctions/${j}/controller/commands`,
  acks: (j: string) => `ftms/v1/junctions/${j}/controller/acks`,
  heartbeat: (j: string) => `ftms/v1/junctions/${j}/controller/heartbeat`,
  controllerStatus: (j: string) => `ftms/v1/junctions/${j}/controller/status`,
  deviceStatus: (j: string) => `ftms/v1/junctions/${j}/devices/status`,
  sensorEvents: (j: string, approach: string) => `ftms/v1/junctions/${j}/sensors/${approach}/events`,
};

export interface MqttOptions { url: string; caFile: string; username: string; password: string }

/**
 * Backend connection: MQTT 5, clean start, session expiry 0 (commands are never queued across a disconnect),
 * retained ONLINE status with an OFFLINE last will that feeds the controllers' watchdog (C-6).
 */
export async function connectBackend(o: MqttOptions, log: (m: string) => void): Promise<MqttClient> {
  const client = await mqtt.connectAsync(o.url, {
    protocolVersion: 5, clean: true, properties: { sessionExpiryInterval: 0 },
    clientId: `ftms-backend-${randomUUID().slice(0, 8)}`, username: o.username, password: o.password,
    ca: readFileSync(o.caFile), reconnectPeriod: 2000, connectTimeout: 5000,
    will: { topic: topics.backendStatus, payload: Buffer.from('OFFLINE'), qos: 1, retain: true },
  });
  const online = () => client.publish(topics.backendStatus, 'ONLINE', { qos: 1, retain: true });
  online();
  client.on('connect', online);
  client.on('offline', () => log('MQTT broker connection lost'));
  client.on('error', (e) => log(`MQTT error: ${e.message}`));
  return client;
}

/** `ControllerGateway` over MQTT. Never retained; the message expires with the command (plan §13.1). */
export class MqttControllerGateway implements ControllerGateway {
  constructor(private readonly client: MqttClient, private readonly clock: () => number = Date.now) {}

  send(junctionId: string, command: WireCommand): void {
    const expiry = Math.max(1, Math.ceil((Date.parse(command.expires_at) - this.clock()) / 1000));
    this.client.publish(topics.commands(junctionId), JSON.stringify(command), { qos: 1, retain: false, properties: { messageExpiryInterval: expiry } });
  }
}

const INBOUND = /^ftms\/v1\/junctions\/([^/]+)\/(?:controller\/(acks|heartbeat|status)|devices\/(status)|sensors\/([^/]+)\/(events))$/;

/**
 * Subscribes to controller and sensor topics and calls the same use cases as the HTTP routes. The broker ACL
 * authenticates the publisher; the payload is still validated exactly like HTTP, and must match its topic.
 */
export class MqttInboundAdapter {
  constructor(private readonly client: MqttClient, private readonly runtime: Runtime, private readonly store: Store, private readonly log: (m: string) => void) {}

  async start(): Promise<void> {
    this.client.on('message', (topic, payload) => void this.handle(topic, payload).catch((e) => this.log(`MQTT ${topic}: ${(e as Error).message}`)));
    await this.client.subscribeAsync([
      'ftms/v1/junctions/+/controller/acks', 'ftms/v1/junctions/+/controller/heartbeat', 'ftms/v1/junctions/+/controller/status',
      'ftms/v1/junctions/+/devices/status', 'ftms/v1/junctions/+/sensors/+/events',
    ], { qos: 1 });
  }

  private reject(topic: string, sourceId: string, reasonCode: string, payload: unknown, detail?: string) {
    return this.store.reject({ channel: 'MQTT', endpoint: topic, sourceId, reasonCode, payload, ...(detail ? { detail } : {}) });
  }

  private parse<S extends ZodTypeAny>(schema: S, body: unknown, topic: string, sourceId: string): S['_output'] | null {
    const r = schema.safeParse(body);
    if (r.success) return r.data;
    void this.reject(topic, sourceId, 'VALIDATION_FAILED', body, r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    return null;
  }

  async handle(topic: string, payload: Buffer): Promise<void> {
    const m = INBOUND.exec(topic);
    if (!m) return;
    const [, j, controllerTopic, deviceStatus, approach] = m as unknown as [string, string, string?, string?, string?];
    const sourceId = approach ? `sensor-${j}-${approach}` : `ctrl-${j}`;
    if (!this.runtime.actors.has(j)) return void this.reject(topic, sourceId, 'UNKNOWN_JUNCTION', payload.toString('utf8').slice(0, 512));

    if (controllerTopic === 'status') {
      // Retained ONLINE / last-will OFFLINE. OFFLINE is reported at once instead of waiting for 3 missed heartbeats.
      if (payload.toString() === 'OFFLINE') {
        await this.runtime.deviceStatus({ eventId: `lwt-${randomUUID()}`, junctionId: j, deviceType: 'SIGNAL_CONTROLLER', status: 'OFFLINE', timestamp: Date.now() }, sourceId, 'DEVICE');
      }
      return;
    }

    let body: unknown;
    try { body = JSON.parse(payload.toString('utf8')); } catch { return void this.reject(topic, sourceId, 'MALFORMED_JSON', payload.toString('utf8').slice(0, 512)); }
    const claimed = body as { junction_id?: unknown; direction?: unknown };
    if (claimed?.junction_id !== j || (approach && claimed.direction !== approach)) return void this.reject(topic, sourceId, 'TOPIC_MISMATCH', body);

    if (approach) {
      const b = this.parse(sensorEventSchema, body, topic, sourceId);
      if (!b) return;
      const out = await this.runtime.sensorEvent(toSensorEvent(b), sourceId, 'DEVICE');
      if (!out.ok && !out.duplicate) await this.reject(topic, sourceId, out.code, body, out.detail);
    } else if (controllerTopic === 'acks') {
      const b = this.parse(ackSchema, body, topic, sourceId);
      if (b) await this.runtime.controllerMessage(j, toAck(b), sourceId, 'DEVICE');
    } else if (controllerTopic === 'heartbeat') {
      const b = this.parse(heartbeatSchema, body, topic, sourceId);
      if (b) await this.runtime.controllerMessage(j, toHeartbeat(b), sourceId, 'DEVICE');
    } else if (deviceStatus) {
      const b = this.parse(deviceStatusSchema, body, topic, sourceId);
      if (b) await this.runtime.deviceStatus(toDeviceStatus(b), sourceId, 'DEVICE');
    }
  }
}
