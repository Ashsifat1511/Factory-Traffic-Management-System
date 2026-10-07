import { mkdirSync, writeFileSync } from 'node:fs';
import { openApiDocument } from '../contracts/openapi.js';

/** npm run openapi:export — writes docs/openapi.json (with the simulation routes). */
const dir = new URL('../../../../docs/', import.meta.url);
mkdirSync(dir, { recursive: true });
writeFileSync(new URL('openapi.json', dir), `${JSON.stringify(openApiDocument({ simulationMode: true }), null, 2)}\n`);
console.log('wrote docs/openapi.json');
