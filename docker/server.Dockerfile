# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile --filter @sniper/server...
COPY packages/core packages/core
COPY apps/server apps/server
RUN pnpm --filter @sniper/server build \
 && pnpm --filter @sniper/server deploy --legacy --prod /out \
 && cp -r apps/server/dist apps/server/drizzle /out/

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S sniper && adduser -S sniper -G sniper
COPY --from=build --chown=sniper:sniper /out /app
USER sniper
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD wget -qO- http://127.0.0.1:4000/health || exit 1
CMD ["node", "dist/main.js"]
