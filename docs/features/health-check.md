# Health Check Probes

Nyx exposes structured health check endpoints so hosting platforms (Railway, Render), load balancers, and monitoring tools can determine whether the API server is safe to receive traffic and whether all downstream dependencies are reachable.

---

## 1. Endpoints

### 1.1 Liveness — `GET /health/live`

Confirms that the Node.js process is running and the Fastify server is accepting connections. **Does not** probe any external service. If this endpoint is reachable, the process is alive.

**Response (always 200):**
```json
{
  "status": "ok",
  "version": "1.4.2",
  "uptime": 38402
}
```

| Field | Type | Description |
|---|---|---|
| `status` | `"ok"` | Always `"ok"` for a live process |
| `version` | `string` | App version from `package.json` |
| `uptime` | `number` | Process uptime in seconds |

Use this as the **liveness probe** target. If it fails, the hosting platform should restart the container.

---

### 1.2 Readiness — `GET /health/ready`

Confirms that the server is ready to serve production traffic by probing every downstream dependency. Returns a per-service breakdown of status and latency.

**Response (200 — all healthy):**
```json
{
  "status": "ok",
  "version": "1.4.2",
  "uptime": 38402,
  "checks": {
    "postgres": { "status": "ok", "latencyMs": 4 },
    "github": { "status": "ok", "latencyMs": 112 },
    "anthropic": { "status": "ok", "latencyMs": 88 },
    "jira": { "status": "ok", "latencyMs": 203 }
  }
}
```

**Response (207 — degraded, one or more services failing):**
```json
{
  "status": "degraded",
  "version": "1.4.2",
  "uptime": 38402,
  "checks": {
    "postgres": { "status": "ok", "latencyMs": 5 },
    "github": { "status": "error", "latencyMs": 5001, "error": "timeout" },
    "anthropic": { "status": "ok", "latencyMs": 91 },
    "jira": { "status": "skipped", "reason": "not configured" }
  }
}
```

**Response codes:**

| Code | Meaning |
|---|---|
| `200` | All configured probes passed |
| `207` | One or more probes failed or timed out; body contains details |
| `503` | PostgreSQL (required dependency) is unreachable |

Use `200` vs. non-`200` as the readiness signal. The hosting platform should stop routing traffic if the readiness probe returns `503`.

---

## 2. Service Probes

### 2.1 PostgreSQL

**Why required:** All core application data (documents, users, version history) lives in Postgres. The API cannot function without it.

**Probe method:** Execute a lightweight query — `SELECT 1` — via the Drizzle ORM connection pool.

**Timeout:** 2 000 ms

**Failure behavior:** Returns `503` overall status. All other probe results are still included in the response body for diagnostics.

---

### 2.2 GitHub API

**Why probed:** Drift detection, webhook dispatch, and ticket creation all depend on the GitHub API. An unreachable GitHub API means those features are silently broken.

**Probe method:** `GET https://api.github.com` — unauthenticated meta endpoint. Returns quickly and does not consume API quota.

**Timeout:** 5 000 ms

**Failure behavior:** Overall status becomes `degraded` (207). The API continues serving requests; GitHub-dependent features degrade gracefully.

---

### 2.3 Anthropic API

**Why probed:** AI spec analysis, drift scoring, and ticket generation call the Anthropic Claude API. Outages silently disable these features.

**Probe method:** `GET https://api.anthropic.com` — simple HTTP reachability check. Does not send a model request (avoids token cost and latency).

**Timeout:** 5 000 ms

**Failure behavior:** Overall status becomes `degraded` (207). Core document editing still works; AI features are unavailable.

---

### 2.4 Jira API

**Why probed:** Jira integration is optional — only configured workspaces use it. The probe is skipped if `JIRA_BASE_URL` is not set.

**Probe method:** `GET <JIRA_BASE_URL>/rest/api/3/serverInfo` with OAuth credentials.

**Timeout:** 5 000 ms

**Failure behavior:** Overall status becomes `degraded` (207) if configured and unreachable. Status is `"skipped"` if not configured.

---

## 3. Response Schema

```ts
type ProbeStatus = 'ok' | 'error' | 'skipped';

interface ServiceCheck {
  status: ProbeStatus;
  latencyMs: number;
  error?: string;   // present when status = 'error'
  reason?: string;  // present when status = 'skipped'
}

interface HealthResponse {
  status: 'ok' | 'degraded' | 'error';
  version: string;
  uptime: number;
  checks?: Record<string, ServiceCheck>; // omitted from /health/live
}
```

`latencyMs` is measured as wall-clock time from probe start to first byte received (or timeout). For `skipped` probes, `latencyMs` is `0`.

---

## 4. Timeout and Failure Handling

Each probe runs with an **independent timeout** using `AbortController`. A probe that exceeds its timeout is recorded as `{ status: "error", latencyMs: <timeout>, error: "timeout" }` — it does not block the other probes.

All probes run **concurrently** via `Promise.allSettled`. The total response time of `/health/ready` is bounded by the slowest probe's timeout (worst case: 5 000 ms), not the sum.

Postgres is given a shorter timeout (2 000 ms) because it is a required dependency and a slow response is itself a signal of degradation.

```
/health/ready latency = max(postgres_timeout, github_timeout, anthropic_timeout, jira_timeout)
                      = max(2000, 5000, 5000, 5000) = 5000 ms (worst case)
```

---

## 5. Caching Strategy

External API probes (GitHub, Anthropic, Jira) are cached in-memory for **30 seconds** to prevent hammering rate-limited endpoints during high-frequency health polling by the hosting platform.

| Probe | Cache TTL | Rationale |
|---|---|---|
| PostgreSQL | None | DB latency must be measured live on every request |
| GitHub API | 30 s | Rate limit: 60 req/hour unauthenticated |
| Anthropic API | 30 s | Unnecessary to poll more frequently |
| Jira API | 30 s | External SaaS; avoid accidental rate-limit hits |

Cache is stored in a module-level `Map<string, { result: ServiceCheck; expiresAt: number }>`. On cache hit, `latencyMs` reflects the cached measurement (not re-measured). The response includes a `cached: true` flag in the service check object when a cached result is returned.

The liveness endpoint (`/health/live`) is never cached — it is a direct process check.

---

## 6. Integration with Hosting Platforms

### Railway

In `railway.json` (or via the Railway dashboard), configure:

```json
{
  "healthcheckPath": "/health/ready",
  "healthcheckTimeout": 10
}
```

Railway polls the readiness endpoint every 10 seconds. A non-2xx response for 3 consecutive checks triggers a restart.

### Render

In `render.yaml`:

```yaml
services:
  - type: web
    name: nyx-api
    healthCheckPath: /health/ready
```

Render uses the readiness endpoint for zero-downtime deploy gates: a new instance only receives traffic once `/health/ready` returns 200.

### Docker / Kubernetes

```dockerfile
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:3000/health/ready || exit 1
```

For Kubernetes, use split probes:

```yaml
livenessProbe:
  httpGet:
    path: /health/live
    port: 3000
  initialDelaySeconds: 5
  periodSeconds: 10

readinessProbe:
  httpGet:
    path: /health/ready
    port: 3000
  initialDelaySeconds: 10
  periodSeconds: 15
  failureThreshold: 2
```

---

## 7. Monitoring and Alerting

### 7.1 Recommended Metrics

Emit the following metrics on every `/health/ready` call (via a future observability integration):

| Metric | Type | Labels |
|---|---|---|
| `health_check_duration_ms` | Histogram | `probe` (postgres/github/anthropic/jira) |
| `health_check_status` | Gauge (0/1) | `probe`, `status` |
| `health_check_overall_status` | Gauge (0=ok, 1=degraded, 2=error) | — |

### 7.2 Alerting Thresholds

| Condition | Severity | Action |
|---|---|---|
| `/health/ready` returns 503 for >1 minute | Critical | Page on-call; platform auto-restarts |
| Postgres `latencyMs` > 500 ms | Warning | Alert; investigate connection pool exhaustion |
| Any external probe `status = "error"` for >5 minutes | Warning | Alert; degraded UX for dependent features |
| `/health/live` unreachable | Critical | Platform restart triggered automatically |

### 7.3 Log Output

On each `/health/ready` call, log a structured JSON line at `info` level:

```json
{
  "event": "health_check",
  "overall": "degraded",
  "checks": {
    "postgres": { "status": "ok", "latencyMs": 4 },
    "github": { "status": "error", "latencyMs": 5001, "error": "timeout" }
  },
  "durationMs": 5003
}
```

Errors from individual probes are logged at `warn` level with the probe name and error message. Do not log at `error` level for degraded-but-non-critical probes, to avoid alert fatigue.

---

## 8. E2E Testing

### 8.1 Critical User Flows

1. **Happy path** — all services healthy: `/health/ready` returns `200` with `status: "ok"` and all checks `"ok"`.
2. **DB unreachable** — Postgres is down: `/health/ready` returns `503` with `checks.postgres.status = "error"`.
3. **External service down** — GitHub API is unreachable: `/health/ready` returns `207` with `status: "degraded"` and `checks.github.status = "error"`.
4. **Jira not configured** — `JIRA_BASE_URL` unset: `checks.jira.status = "skipped"`.
5. **Liveness always passes** — even when DB is down, `/health/live` returns `200`.
6. **Cache hit** — two rapid calls to `/health/ready` return `cached: true` on external probe checks for the second call.

### 8.2 Test Scenarios (Given/When/Then)

**Scenario 1: All services healthy**
```
Given: Postgres, GitHub API, and Anthropic API are all reachable
  And: Jira is not configured (JIRA_BASE_URL unset)
When: GET /health/ready
Then: Response status is 200
  And: body.status = "ok"
  And: checks.postgres.status = "ok"
  And: checks.github.status = "ok"
  And: checks.anthropic.status = "ok"
  And: checks.jira.status = "skipped"
```

**Scenario 2: Postgres unreachable**
```
Given: Postgres connection is refused (DATABASE_URL points to a closed port)
When: GET /health/ready
Then: Response status is 503
  And: body.status = "error"
  And: checks.postgres.status = "error"
  And: checks.postgres.error = "timeout" or connection error message
  And: Other checks are still present in the body
```

**Scenario 3: GitHub API times out**
```
Given: GitHub API probe is intercepted and hangs beyond the 5000 ms timeout
When: GET /health/ready
Then: Response status is 207
  And: body.status = "degraded"
  And: checks.github.status = "error"
  And: checks.github.latencyMs >= 5000
  And: checks.postgres.status = "ok" (DB probe was not affected)
```

**Scenario 4: Liveness is independent of DB**
```
Given: Postgres is unreachable
When: GET /health/live
Then: Response status is 200
  And: body.status = "ok"
  And: Response body does not contain a "checks" field
```

**Scenario 5: Caching — second call uses cached probe result**
```
Given: GitHub API probe cache TTL is 30 seconds
  And: A call to /health/ready was made less than 30 seconds ago
When: GET /health/ready is called again
Then: checks.github.cached = true
  And: The probe was NOT re-fetched (verified via intercepted HTTP request count)
```

### 8.3 Integration Boundaries

| External Service | Test Strategy |
|---|---|
| PostgreSQL | Use a real test DB for happy-path; use an invalid `DATABASE_URL` to simulate failure |
| GitHub API (`api.github.com`) | Intercept with Playwright's `page.route()` or an MSW mock server; return 200 or simulate timeout |
| Anthropic API (`api.anthropic.com`) | Same as GitHub — mock at HTTP level, not SDK level |
| Jira API | Set/unset `JIRA_BASE_URL` env var; mock HTTP responses when set |

Health check probes are purely HTTP-level — mock at the network layer rather than injecting mocks into the application code, so tests exercise the real probe implementation.

### 8.4 Test Data Requirements

- **Real PostgreSQL instance:** required for happy-path tests; the test database used by the broader test suite is sufficient (no special seed data needed — `SELECT 1` probe requires no schema).
- **No user/document seed data required** — health endpoints are unauthenticated and stateless.
- **Environment variables:**
  - `DATABASE_URL` — real test DB for happy-path; set to `postgres://localhost:1/nonexistent` for failure scenarios
  - `GITHUB_TOKEN` — not required for the probe (uses unauthenticated endpoint); set to any non-empty string to avoid missing-env errors
  - `ANTHROPIC_API_KEY` — set to any non-empty string; probe does not make authenticated requests
  - `JIRA_BASE_URL` — omit to test `"skipped"` status; set to a mock URL for configured tests

### 8.5 Playwright Test File Locations

```
e2e/
  health/
    health-live.spec.ts       # Liveness probe: always-ok, response schema, no checks field
    health-ready.spec.ts      # Readiness probe: happy path, per-service status breakdown
    health-degraded.spec.ts   # Degraded scenarios: DB down (503), external service timeouts (207)
    health-caching.spec.ts    # Cache behavior: second call returns cached: true within TTL
    health-skipped.spec.ts    # Optional service behavior: Jira skipped when unconfigured
```

### 8.6 CI Considerations

- **Service containers:** CI must run a real PostgreSQL container for happy-path tests. Add a `postgres` service to `.github/workflows/ci.yml` (or reuse the existing test DB service if present).
- **Network interception for external probes:** Use Playwright's `page.route()` or a lightweight MSW mock server started as part of test setup to intercept calls to `api.github.com` and `api.anthropic.com`. This avoids real network calls and prevents flaky tests due to external service availability.
- **Simulating DB failure:** Spawn the API server with a deliberately broken `DATABASE_URL` for `health-degraded.spec.ts`. Use a separate Playwright project or a `test.use({ baseURL })` override to point tests at this isolated server instance.
- **Environment variables in CI:**
  ```yaml
  env:
    DATABASE_URL: ${{ secrets.TEST_DATABASE_URL }}
    GITHUB_TOKEN: test-token-placeholder
    ANTHROPIC_API_KEY: test-key-placeholder
    # JIRA_BASE_URL intentionally omitted for skip tests
  ```
- **Probe cache TTL in tests:** Override the cache TTL to a very low value (e.g., 100 ms) via an environment variable (`HEALTH_CACHE_TTL_MS`) so cache-expiry tests do not need to wait 30 seconds.
- **Test isolation:** Health endpoints are stateless; no per-test DB cleanup is required.
