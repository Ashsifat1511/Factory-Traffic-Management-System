# Dashboard: static Vite build served by nginx, which also proxies /api to the backend (same origin, no CORS).
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/
RUN npm ci -w @ftms/web --no-audit --no-fund
COPY apps/web apps/web
RUN cd apps/web && npx vite build

FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
