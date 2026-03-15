# Health Check Probes

## Overview

Nyx exposes two health check endpoints on the Fastify API server following the Kubernetes liveness/readiness probe pattern. These endpoints allow orchestrators, load balancers, and monitoring systems to determine whether the service is alive and whether it is ready to accept traffic.

- **Liveness probe** — confirms the process is running and can handle HTTP requests. It does not verify any external dependencies.
- **Readiness probe** — confirms the process is running *and* all critical dependencies (database, Clerk, GitHub, Stripe) are reachable and responding within acceptable latency thresholds.

---

## Endpoints

### `GET /health/live`

Returns `200 OK` if the Fastify process is running. No external dependencies are checked.

**Response (200):**

```json
{
  "status": "ok"
}
```

This endpoint always returns `200` as long as the process can serve HTTP. It is suitable for Kubernetes `livenessProbe` configuration — a failure here indicates the process should be restarted.

---

### `GET /health/ready`

Returns `200 OK` only when all critical dependencies are healthy. Returns `503 Service Unavailable` when one or more dependencies are down or degraded beyond the acceptable threshold.

**Response (200 — all healthy):**

```json
{
  "status": "ok",
  "checks": {
    "database": { "status": "ok", "latencyMs": 12 },
    "clerk": { "status": "ok", "latencyMs": 45 },
    "github": { "status": "ok", "latencyMs": 102 },
    "stripe": { "status": "ok", "latencyMs": 88 }
  },
  "version": "1.2.0",
  "uptime": 84321
}
```

**Response (503 — degraded):**

```json
{
  "status": "degraded",
  "checks": {
    "database": { "status": "ok", "latencyMs": 14 },
    "clerk": { "status": "ok", "latencyMs": 52 },
    "github": { "status": "unavailable", "latencyMs": null, "error": "connect ETIMEDOUT" },
    "stripe": { "status": "ok", "latencyMs": 91 }
  },
  "version": "1.2.0",
  "uptime": 84321
}
```

**Response (503 — unavailable):**

```json
{
  "status": "unavailable",
  "checks": {
    "database": { "status": "unavailable", "latencyMs": null, "error": "connect ECONNREFUSED" },
    "clerk": { "status": "unavailable", "latencyMs": null, "error": "connect ETIMEDOUT" },
    "github": { "status": "unavailable", "latencyMs": null, "error": "connect ETIMEDOUT" },
    "stripe": { "status": "unavailable", "latencyMs": null, "error": "connect ETIMEDOUT" }
  },
  "version": "1.2.0",
  "uptime": 84321
}
```

This endpoint is suitable for Kubernetes `readinessProbe` configuration — a failure here causes the pod to be removed from the Service load balancer until it recovers.

---

## Service Probes

Each dependency is checked with a lightweight, read-only request. Probes run concurrently (via `Promise.allSettled`) to minimize total latency.

| Dependency | Probe Method | Target | Success Criteria |
|------------|-------------|--------|-----------------|
| **Database** | SQL query | `SELECT 1` via the Drizzle ORM connection pool | Query returns within the configured timeout |
| **Clerk** | HTTP GET | JWKS endpoint (`/.well-known/jwks.json` on Clerk's API) | 200 response within timeout |
| **GitHub** | HTTP GET | `https://api.github.com/rate_limit` | 200 response within timeout (does not consume rate limit) |
| **Stripe** | HTTP GET | `https://api.stripe.com/v1/balance` with the API secret key | 200 response within timeout |

### Probe Implementation Notes

- All HTTP probes use `AbortController` with a per-probe timeout to prevent a single slow dependency from blocking the entire readiness response.
- The database probe uses the existing Drizzle connection pool. If the pool is exhausted, the probe will time out, which correctly signals that the service is not ready.
- Probe results are not cached. Each request to `/health/ready` runs fresh probes to give an accurate point-in-time status.

---

## Response Schema

### Top-Level Fields

| Field | Type | Description |
|-------|------|-------------|
| `status` | `"ok" \| "degraded" \| "unavailable"` | Aggregate health status |
| `checks` | `Record<string, CheckResult>` | Per-dependency probe results |
| `version` | `string` | Application version from `package.json` |
| `uptime` | `number` | Process uptime in seconds (`process.uptime()`) |

### `CheckResult` Fields

| Field | Type | Description |
|-------|------|-------------|
| `status` | `"ok" \| "unavailable"` | Whether the individual dependency is reachable |
| `latencyMs` | `number \| null` | Round-trip latency in milliseconds, or `null` if the probe failed |
| `error` | `string` (optional) | Human-readable error message, present only when `status` is `"unavailable"` |

### Aggregate Status Logic

The top-level `status` is derived from the individual check results:

| Condition | Aggregate Status | HTTP Code |
|-----------|-----------------|-----------|
| All checks return `"ok"` | `"ok"` | 200 |
| At least one check is `"unavailable"`, but `database` is `"ok"` | `"degraded"` | 503 |
| `database` check is `"unavailable"` | `"unavailable"` | 503 |

The database is treated as the critical dependency. If it is down, the service is considered fully unavailable regardless of other probe results.

---

## Error Handling

### Probe-Level Failures

When an individual probe fails (timeout, connection refused, DNS resolution error, non-2xx response):

1. The probe's `status` is set to `"unavailable"`.
2. The `latencyMs` field is set to `null`.
3. The `error` field is populated with a short description of the failure (e.g., `"connect ECONNREFUSED"`, `"timeout after 3000ms"`).

### Aggregate Failure

- **Degraded**: The service can still handle most requests, but some features that depend on the unavailable service may not work. For example, if GitHub is unreachable, drift detection will not function, but document editing will still work.
- **Unavailable**: The database is down. The service cannot function meaningfully and should be removed from the load balancer.

### Timeouts

If a probe does not complete within its configured timeout, it is treated identically to a connection failure. The `AbortController` signal ensures the underlying HTTP request or database query is cancelled.

---

## Configuration

Health check behavior is controlled via environment variables with sensible defaults.

| Variable | Default | Description |
|----------|---------|-------------|
| `HEALTH_PROBE_TIMEOUT_MS` | `3000` | Maximum time (ms) each individual probe is allowed before it is considered failed |
| `HEALTH_PROBE_INTERVAL_MS` | `30000` | Suggested interval for external systems polling the readiness endpoint |
| `HEALTH_LOG_FAILURES` | `true` | Whether to log probe failures at `warn` level via Fastify's logger |

### Kubernetes Configuration Example

```yaml
livenessProbe:
  httpGet:
    path: /health/live
    port: 3001
  initialDelaySeconds: 5
  periodSeconds: 10
  failureThreshold: 3

readinessProbe:
  httpGet:
    path: /health/ready
    port: 3001
  initialDelaySeconds: 10
  periodSeconds: 30
  failureThreshold: 2
```

---

## E2E Test Spec

The following test cases validate health check behavior. Tests are located in `e2e/health-check.spec.ts` and use Playwright's `request` API context for direct HTTP assertions.

### Test Cases

#### 1. Healthy state returns 200

- **Precondition**: All dependencies are available.
- **Action**: `GET /health/ready`
- **Assertion**: Response status is `200`. Body `status` is `"ok"`. Every entry in `checks` has `status: "ok"` and a numeric `latencyMs`. The `version` field is a non-empty string. The `uptime` field is a positive number.

#### 2. Database down returns 503 with unavailable status

- **Precondition**: The database connection is severed (e.g., invalid `DATABASE_URL` or database container stopped).
- **Action**: `GET /health/ready`
- **Assertion**: Response status is `503`. Body `status` is `"unavailable"`. `checks.database.status` is `"unavailable"`. `checks.database.error` is a non-empty string.

#### 3. Partial failure shows degraded status

- **Precondition**: The database is healthy, but one non-critical dependency (e.g., GitHub) is unreachable.
- **Action**: `GET /health/ready`
- **Assertion**: Response status is `503`. Body `status` is `"degraded"`. `checks.database.status` is `"ok"`. At least one other check has `status: "unavailable"`.

#### 4. Liveness always returns 200 regardless of dependency state

- **Precondition**: One or more dependencies are down.
- **Action**: `GET /health/live`
- **Assertion**: Response status is `200`. Body is `{ "status": "ok" }`. No `checks` field is present in the response.
