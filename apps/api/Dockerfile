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

# Copy everything from deps (includes all dependencies + drizzle-kit)
COPY --from=deps /app/ ./

COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY apps/api/drizzle ./apps/api/drizzle
COPY apps/api/drizzle.config.ts ./apps/api/drizzle.config.ts
COPY apps/api/tsconfig.json ./apps/api/tsconfig.json

EXPOSE 3001

CMD ["sh", "-c", "cd apps/api && npx drizzle-kit push --force 2>&1; cd /app && node apps/api/dist/index.js"]
