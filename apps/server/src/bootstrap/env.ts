import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** Loads `.env` from the repository root without overriding real environment variables. */
export function loadDotEnv(path = new URL('../../../../.env', import.meta.url)) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(#.*)?$/.exec(line);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
  }
}

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(8080),
  DATABASE_URL: z.string().url(),
  DATABASE_OWNER_URL: z.string().url(),
  DASHBOARD_ORIGIN: z.string().default('http://localhost:3000,http://127.0.0.1:3000'),
  SESSION_COOKIE_SECURE: bool.default('false'),
  DEVICE_KEY_PEPPER: z.string().min(16),
  SIMULATION_MODE: bool.default('false'),
  ALLOW_SIMULATION_IN_PRODUCTION: bool.default('false'),
  CONTROLLER_TRANSPORT: z.enum(['rest', 'mqtt']).default('rest'),
  CONTROLLER_SIM_URL: z.string().default('http://localhost:8090'),
  BACKEND_TO_SIM_TOKEN: z.string().min(8),
  MQTT_URL: z.string().default('mqtts://localhost:8883'),
  MQTT_CA_FILE: z.string().default('infra/mosquitto/certs/ca.crt'),
  MQTT_USERNAME: z.string().default('ftms-backend'),
  MQTT_PASSWORD_FTMS_BACKEND: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export const repoPath = (p: string) => (/^([A-Za-z]:)?[\\/]/.test(p) ? p : fileURLToPath(new URL(`../../../../${p}`, import.meta.url)));

export function readEnv(): Env {
  loadDotEnv();
  loadDotEnv(new URL('../../../../.mqtt-creds.env', import.meta.url)); // written by `npm run mqtt:users`
  const env = envSchema.parse(process.env);
  if (env.NODE_ENV === 'production' && env.SIMULATION_MODE && !env.ALLOW_SIMULATION_IN_PRODUCTION) {
    throw new Error('Refusing to start: SIMULATION_MODE=true in production (set ALLOW_SIMULATION_IN_PRODUCTION to override)');
  }
  if (env.CONTROLLER_TRANSPORT === 'mqtt' && !env.MQTT_PASSWORD_FTMS_BACKEND) {
    throw new Error('CONTROLLER_TRANSPORT=mqtt needs MQTT_PASSWORD_FTMS_BACKEND (run `npm run mqtt:users`)');
  }
  return env;
}
