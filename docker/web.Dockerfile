# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /repo

FROM base AS build
# Rewrites and NEXT_PUBLIC_* values are fixed at build time.
ARG API_INTERNAL_URL=http://server:4000
ARG NEXT_PUBLIC_WS_URL=
ENV API_INTERNAL_URL=$API_INTERNAL_URL NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL NEXT_TELEMETRY_DISABLED=1
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @sniper/web...
COPY packages/core packages/core
COPY apps/web apps/web
RUN pnpm --filter @sniper/web build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
RUN addgroup -S sniper && adduser -S sniper -G sniper
COPY --from=build --chown=sniper:sniper /repo/apps/web/.next/standalone ./
COPY --from=build --chown=sniper:sniper /repo/apps/web/.next/static ./apps/web/.next/static
USER sniper
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
