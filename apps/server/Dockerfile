# Backend API. Runs the TypeScript sources with tsx (no separate build step), as a non-root user.
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/domain/package.json packages/domain/
COPY packages/sim-core/package.json packages/sim-core/
COPY apps/server/package.json apps/server/
RUN npm ci -w @ftms/server -w @ftms/domain -w @ftms/sim-core --include-workspace-root --no-audit --no-fund && npm cache clean --force
COPY packages/domain packages/domain
COPY packages/sim-core packages/sim-core
COPY apps/server apps/server
COPY config config
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:8080/api/health/live || exit 1
CMD ["node", "--import", "tsx", "apps/server/src/main.ts"]
