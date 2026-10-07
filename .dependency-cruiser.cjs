/** Architecture rules from plan §2.3. Run with `npm run lint:arch`. */
module.exports = {
  forbidden: [
    {
      name: 'domain-is-pure',
      comment: 'packages/domain and packages/sim-core import nothing outside themselves: no Node built-ins, no libraries.',
      severity: 'error',
      from: { path: '^packages/(domain|sim-core)/src' },
      to: { pathNot: '^packages/$1/' },
    },
    {
      name: 'application-has-no-io',
      comment: 'The application layer depends on the domain and its own ports, never on adapters, Fastify, pg or mqtt.',
      severity: 'error',
      from: { path: '^apps/server/src/application' },
      to: { path: ['^apps/server/src/(adapters|bootstrap)', 'node_modules/(fastify|@fastify|pg|mqtt)/'] },
    },
    {
      name: 'adapters-are-independent',
      comment: 'An adapter never depends on another adapter at runtime (type-only imports of a repository are allowed).',
      severity: 'error',
      from: { path: '^apps/server/src/adapters/([^/]+)/' },
      to: { path: '^apps/server/src/adapters/', pathNot: '^apps/server/src/adapters/$1/', dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'contracts-are-leaf',
      comment: 'Contracts (zod schemas and wire mappers) never depend on server code; domain types only.',
      severity: 'error',
      from: { path: '^apps/server/src/contracts' },
      to: { path: '^apps/server/src/(application|adapters|bootstrap)' },
    },
    {
      name: 'web-is-a-client',
      comment: 'The dashboard talks to the API only; it never imports server or domain code.',
      severity: 'error',
      from: { path: '^apps/web' },
      to: { path: '^(apps/server|apps/controller-sim|packages/)' },
    },
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(/dist/|/test/)' },
    parser: 'swc', // TypeScript 7 has no compiler API yet; swc parses the sources
    tsPreCompilationDeps: true,
    combinedDependencies: true,
  },
};
