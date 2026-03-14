# ── Base ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS base
RUN npm install -g pnpm@9.15.4
WORKDIR /app

# ── Dependencies ──────────────────────────────────────────────────────
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc* ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared/package.json ./packages/shared/
RUN pnpm install --frozen-lockfile

# ── Builder ───────────────────────────────────────────────────────────
FROM base AS builder
COPY --from=deps /app/ ./
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api
RUN pnpm --filter "@syncdocs/shared" build
RUN pnpm --filter "@syncdocs/api" build

# ── Production runner ─────────────────────────────────────────────────
FROM node:20-alpine AS runner
RUN npm install -g pnpm@9.15.4
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc* ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared/package.json ./packages/shared/

RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY apps/api/drizzle ./apps/api/drizzle
COPY apps/api/drizzle.config.ts ./apps/api/drizzle.config.ts

EXPOSE 3001

CMD ["sh", "-c", "pnpm --filter @syncdocs/api db:migrate && node apps/api/dist/index.js"]
