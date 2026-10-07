import { buildApp } from './adapters/http/app.js';
import { RestControllerGateway } from './adapters/controller/rest.js';
import { createPool, migrate } from './adapters/postgres/db.js';
import { Security } from './adapters/postgres/security.js';
import { Store } from './adapters/postgres/store.js';
import { Runtime } from './application/runtime.js';
import { connectBackend, MqttControllerGateway, MqttInboundAdapter } from './adapters/mqtt/mqtt.js';
import { readEnv, repoPath } from './bootstrap/env.js';

const env = readEnv();
const ownerPool = createPool(env.DATABASE_OWNER_URL);
const pool = createPool(env.DATABASE_URL);

async function connectWithRetry() {
  for (let attempt = 1; ; attempt++) {
    try { await pool.query('SELECT 1'); return; } catch (e) {
      if (attempt >= 3) throw e; // fail fast: controllers fall back to local fail-safe (plan §9.4)
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

await connectWithRetry();
await migrate(ownerPool, (m) => console.log(`[migrate] ${m}`));
await ownerPool.end();

// Single-instance guard (plan §9.2 step 3): hold an advisory lock for the life of the process.
const lockClient = await pool.connect();
const { rows } = await lockClient.query('SELECT pg_try_advisory_lock(424242) AS ok');
if (!rows[0].ok) {
  console.error('Another backend instance controls the junctions. Exiting.');
  process.exit(1);
}

const store = new Store(pool);
const security = new Security(pool, env.DEVICE_KEY_PEPPER, store);
// CONTROLLER_TRANSPORT selects the adapter (plan §13.3); the domain and use cases are identical for both.
const mqttClient = env.CONTROLLER_TRANSPORT === 'mqtt'
  ? await connectBackend({ url: env.MQTT_URL, caFile: repoPath(env.MQTT_CA_FILE), username: env.MQTT_USERNAME, password: env.MQTT_PASSWORD_FTMS_BACKEND! }, (m) => console.warn(m))
  : null;
const gateway = mqttClient ? new MqttControllerGateway(mqttClient) : new RestControllerGateway(env.CONTROLLER_SIM_URL, env.BACKEND_TO_SIM_TOKEN, (m) => console.warn(m));
const runtime = new Runtime(store, gateway);
const app = await buildApp({
  runtime, store, security, simulationMode: env.SIMULATION_MODE, dashboardOrigin: env.DASHBOARD_ORIGIN,
  cookieSecure: env.SESSION_COOKIE_SECURE, simulator: { url: env.CONTROLLER_SIM_URL, token: env.BACKEND_TO_SIM_TOKEN },
  ...(mqttClient ? { brokerConnected: () => mqttClient.connected } : {}),
  production: env.NODE_ENV === 'production',
});
await store.audit('SYSTEM', null, [{ type: 'SYSTEM_STARTED', severity: 'INFO', details: { simulationMode: env.SIMULATION_MODE, transport: env.CONTROLLER_TRANSPORT } }], 'SYSTEM');
await runtime.start();
if (mqttClient) await new MqttInboundAdapter(mqttClient, runtime, store, (m) => console.warn(m)).start();
setInterval(() => void store.purge().catch(() => undefined), 24 * 3600_000).unref();
await app.listen({ port: env.PORT, host: '0.0.0.0' });

const shutdown = async () => {
  runtime.stop();
  await mqttClient?.endAsync();
  await app.close();
  lockClient.release();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
