# Controller simulator: a separate process standing in for the junction controllers (plan §8.5).
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/sim-core/package.json packages/sim-core/
COPY apps/controller-sim/package.json apps/controller-sim/
RUN npm ci -w @ftms/controller-sim -w @ftms/sim-core --include-workspace-root --no-audit --no-fund && npm cache clean --force
COPY packages/sim-core packages/sim-core
COPY apps/controller-sim apps/controller-sim
COPY config config
USER node
EXPOSE 8090
CMD ["node", "--import", "tsx", "apps/controller-sim/src/main.ts"]
