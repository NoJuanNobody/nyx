# Health Check Implementation Notes

## What changed
Added Kubernetes-style liveness and readiness probe endpoints to the Fastify API server.

- `GET /health/live` — always returns 200 `{ status: "ok" }` (process alive check)
- `GET /health/ready` — checks database, Clerk, GitHub, and Stripe concurrently via `Promise.allSettled`, returns 200 when all healthy, 503 when degraded or unavailable

## Files modified
- `apps/api/src/routes/health.ts` — rewrote to add `/health/live` and `/health/ready` endpoints with concurrent service probes (kept legacy `/health` endpoint for backward compatibility)
- `apps/api/src/lib/config.ts` — added `HEALTH_PROBE_TIMEOUT_MS` (default 3000) and `HEALTH_LOG_FAILURES` (default true) config vars
- `apps/api/src/__tests__/routes/health.test.ts` — comprehensive tests: 10 tests covering liveness, readiness (all healthy, db down, partial failure, missing config, non-2xx responses)
- `apps/api/src/__tests__/helpers/setup.ts` — added `execute` method to mockDb + `HEALTH_PROBE_TIMEOUT_MS`/`HEALTH_LOG_FAILURES` to config mock
- `packages/shared/src/types/health.ts` — new file: shared Zod schemas and TypeScript types for health check responses (`CheckResult`, `LivenessResponse`, `ReadinessResponse`, `HealthStatus`, `DependencyName`)
- `packages/shared/src/index.ts` — re-exports health types

## Assumptions
- The legacy `GET /health` endpoint was preserved for backward compatibility (existing monitoring/load balancers may use it)
- Clerk JWKS URL is derived from the publishable key's base64-encoded domain (standard Clerk convention)
- Stripe probe uses `GET /v1/balance` with the secret key (lightweight auth-required endpoint)
- GitHub probe uses `GET /api.github.com/rate_limit` (does not consume rate limit)
- App version is read from the root `package.json` at module load time
- `HEALTH_PROBE_INTERVAL_MS` from the spec is a suggestion for external systems, not implemented server-side

## Governance conflicts
- None. The spec requested an `.md` file for swarm notes which is allowed per orchestrator instructions.

## Follow-up items
- E2E tests (`e2e/health-check.spec.ts`) were specified in the feature doc but not implemented in this ticket since they require a running server with real dependencies. Could be added as integration tests.
- The `HEALTH_PROBE_INTERVAL_MS` env var from the spec is documented but not enforced server-side (it's an advisory value for Kubernetes/monitoring configuration).
