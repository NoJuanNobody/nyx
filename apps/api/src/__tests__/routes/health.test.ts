import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

// ── DB mock ────────────────────────────────────────────────────────

const mockExecute = vi.fn().mockResolvedValue([{ '?column?': 1 }]);
vi.mock('../../db/index.js', () => ({
  db: {
    execute: mockExecute,
    select: vi.fn(() => ({ from: vi.fn() })),
  },
}));

// ── Config proxy mock ──────────────────────────────────────────────

const mockConfig: Record<string, unknown> = {
  HEALTH_PROBE_TIMEOUT_MS: 3000,
  HEALTH_LOG_FAILURES: false,
  CLERK_PUBLISHABLE_KEY: 'pk_test_dGVzdC5jbGVyay5hY2NvdW50cy5kZXYk',
  STRIPE_SECRET_KEY: 'sk_test_fake',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  PORT: 3001,
  HOST: '0.0.0.0',
  NODE_ENV: 'test',
  CLERK_SECRET_KEY: 'test-clerk-secret',
};

// ── Fetch mock ─────────────────────────────────────────────────────

const mockFetch = vi.fn<(...args: unknown[]) => Promise<Response>>();
vi.stubGlobal('fetch', mockFetch);

vi.mock('../../lib/config.js', () => ({
  config: new Proxy(
    {},
    {
      get(_target, prop: string) {
        return mockConfig[prop];
      },
    },
  ),
}));

// ── Helpers ────────────────────────────────────────────────────────

async function buildApp() {
  const app = Fastify({ logger: false });
  app.register(healthRoutes);
  await app.ready();
  return app;
}

function okFetchResponse(): Partial<Response> {
  return { ok: true, status: 200, statusText: 'OK' };
}

function errorFetchResponse(status: number, statusText: string): Partial<Response> {
  return { ok: false, status, statusText };
}

// ── Tests ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Reset config overrides
  mockConfig.CLERK_PUBLISHABLE_KEY = 'pk_test_dGVzdC5jbGVyay5hY2NvdW50cy5kZXYk';
  mockConfig.STRIPE_SECRET_KEY = 'sk_test_fake';
  mockConfig.HEALTH_PROBE_TIMEOUT_MS = 3000;
  mockConfig.HEALTH_LOG_FAILURES = false;
  // Reset db.execute fully (clear queued once-values) then set default
  mockExecute.mockReset();
  mockExecute.mockResolvedValue([{ '?column?': 1 }]);
  // Reset fetch fully too
  mockFetch.mockReset();
});

// Import health routes AFTER mocks are set up (vi.mock is hoisted)
const { healthRoutes } = await import('../../routes/health.js');

describe('GET /health (legacy)', () => {
  it('returns { status: "ok" } with 200', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});

describe('GET /health/live', () => {
  it('always returns 200 with { status: "ok" }', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/health/live' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('returns 200 even when dependencies are down', async () => {
    // Simulate broken database — should not matter for liveness
    mockExecute.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/health/live' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    // No checks field in liveness response
    expect(res.json()).not.toHaveProperty('checks');
  });
});

describe('GET /health/ready', () => {
  it('returns 200 with status "ok" when all dependencies are healthy', async () => {
    mockExecute.mockResolvedValue([{ '?column?': 1 }]);
    mockFetch.mockResolvedValue(okFetchResponse() as Response);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    const body = res.json();

    expect(res.statusCode).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.checks.database.status).toBe('ok');
    expect(typeof body.checks.database.latencyMs).toBe('number');
    expect(body.checks.clerk.status).toBe('ok');
    expect(body.checks.github.status).toBe('ok');
    expect(body.checks.stripe.status).toBe('ok');
    expect(typeof body.version).toBe('string');
    expect(body.version.length).toBeGreaterThan(0);
    expect(typeof body.uptime).toBe('number');
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });

  it('returns 503 with "unavailable" when database is down', async () => {
    mockExecute.mockRejectedValue(new Error('connect ECONNREFUSED'));
    mockFetch.mockResolvedValue(okFetchResponse() as Response);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    const body = res.json();

    expect(res.statusCode).toBe(503);
    expect(body.status).toBe('unavailable');
    expect(body.checks.database.status).toBe('unavailable');
    expect(body.checks.database.latencyMs).toBeNull();
    expect(typeof body.checks.database.error).toBe('string');
    expect(body.checks.database.error.length).toBeGreaterThan(0);
    // Other services can still be ok
    expect(body.checks.clerk.status).toBe('ok');
  });

  it('returns 503 with "degraded" when a non-critical dependency is down but database is ok', async () => {
    mockExecute.mockResolvedValue([{ '?column?': 1 }]);

    // GitHub fails, others succeed
    mockFetch.mockImplementation(async (url: unknown) => {
      const urlStr = String(url);
      if (urlStr.includes('api.github.com')) {
        throw new Error('connect ETIMEDOUT');
      }
      return okFetchResponse() as Response;
    });

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    const body = res.json();

    expect(res.statusCode).toBe(503);
    expect(body.status).toBe('degraded');
    expect(body.checks.database.status).toBe('ok');
    expect(body.checks.github.status).toBe('unavailable');
    expect(typeof body.checks.github.error).toBe('string');
  });

  it('reports unavailable for clerk when CLERK_PUBLISHABLE_KEY is not configured', async () => {
    mockConfig.CLERK_PUBLISHABLE_KEY = undefined;
    mockExecute.mockResolvedValue([{ '?column?': 1 }]);
    mockFetch.mockResolvedValue(okFetchResponse() as Response);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    const body = res.json();

    expect(body.checks.clerk.status).toBe('unavailable');
    expect(body.checks.clerk.error).toContain('not configured');
  });

  it('reports unavailable for stripe when STRIPE_SECRET_KEY is not configured', async () => {
    mockConfig.STRIPE_SECRET_KEY = undefined;
    mockExecute.mockResolvedValue([{ '?column?': 1 }]);
    mockFetch.mockResolvedValue(okFetchResponse() as Response);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    const body = res.json();

    expect(body.checks.stripe.status).toBe('unavailable');
    expect(body.checks.stripe.error).toContain('not configured');
  });

  it('handles non-2xx HTTP responses from dependencies', async () => {
    mockExecute.mockResolvedValue([{ '?column?': 1 }]);
    mockFetch.mockResolvedValue(errorFetchResponse(500, 'Internal Server Error') as Response);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    const body = res.json();

    // All HTTP probes should report unavailable due to non-2xx
    expect(body.checks.clerk.status).toBe('unavailable');
    expect(body.checks.clerk.error).toContain('HTTP 500');
    expect(body.checks.github.status).toBe('unavailable');
    expect(body.checks.stripe.status).toBe('unavailable');
  });

  it('includes version and uptime in response', async () => {
    mockExecute.mockResolvedValue([{ '?column?': 1 }]);
    mockFetch.mockResolvedValue(okFetchResponse() as Response);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    const body = res.json();

    expect(typeof body.version).toBe('string');
    expect(typeof body.uptime).toBe('number');
  });
});
