import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { config } from '../lib/config.js';
import type { CheckResult, ReadinessResponse, HealthStatus } from '@nyx/shared';

// Read version once at module load
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let appVersion = '0.0.0';
try {
  const pkg = JSON.parse(
    readFileSync(resolve(__dirname, '../../../../package.json'), 'utf-8'),
  );
  appVersion = pkg.version ?? '0.0.0';
} catch {
  // If package.json is unreadable, fall back to default
}

// ── Individual Probes ──────────────────────────────────────────────

async function probeDatabase(timeoutMs: number): Promise<CheckResult> {
  const start = performance.now();
  try {
    await Promise.race([
      db.execute(sql`SELECT 1`),
      rejectAfter(timeoutMs),
    ]);
    return { status: 'ok', latencyMs: Math.round(performance.now() - start) };
  } catch (err) {
    return {
      status: 'unavailable',
      latencyMs: null,
      error: errorMessage(err, timeoutMs),
    };
  }
}

async function probeClerk(timeoutMs: number): Promise<CheckResult> {
  const publishableKey = config.CLERK_PUBLISHABLE_KEY;
  if (!publishableKey) {
    return { status: 'unavailable', latencyMs: null, error: 'CLERK_PUBLISHABLE_KEY not configured' };
  }
  // Extract the Clerk frontend API domain from the publishable key
  // Format: pk_test_<base64-encoded-domain>
  const encoded = publishableKey.replace(/^pk_(test|live)_/, '');
  const domain = Buffer.from(encoded, 'base64').toString('utf-8').replace(/\$$/, '');
  const url = `https://${domain}/.well-known/jwks.json`;
  return probeHttp(url, timeoutMs);
}

async function probeGitHub(timeoutMs: number): Promise<CheckResult> {
  return probeHttp('https://api.github.com/rate_limit', timeoutMs);
}

async function probeStripe(timeoutMs: number): Promise<CheckResult> {
  const secretKey = config.STRIPE_SECRET_KEY;
  if (!secretKey) {
    return { status: 'unavailable', latencyMs: null, error: 'STRIPE_SECRET_KEY not configured' };
  }
  return probeHttp('https://api.stripe.com/v1/balance', timeoutMs, {
    Authorization: `Bearer ${secretKey}`,
  });
}

// ── Helpers ────────────────────────────────────────────────────────

async function probeHttp(
  url: string,
  timeoutMs: number,
  headers?: Record<string, string>,
): Promise<CheckResult> {
  const start = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers });
    clearTimeout(timer);
    if (!res.ok) {
      return {
        status: 'unavailable',
        latencyMs: Math.round(performance.now() - start),
        error: `HTTP ${res.status} ${res.statusText}`,
      };
    }
    return { status: 'ok', latencyMs: Math.round(performance.now() - start) };
  } catch (err) {
    clearTimeout(timer);
    return {
      status: 'unavailable',
      latencyMs: null,
      error: errorMessage(err, timeoutMs),
    };
  }
}

function rejectAfter(ms: number): Promise<never> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
  });
}

function errorMessage(err: unknown, timeoutMs: number): string {
  if (err instanceof Error) {
    if (err.name === 'AbortError') return `timeout after ${timeoutMs}ms`;
    return err.message;
  }
  return String(err);
}

function deriveStatus(
  checks: Record<string, CheckResult>,
): HealthStatus {
  const allOk = Object.values(checks).every((c) => c.status === 'ok');
  if (allOk) return 'ok';
  if (checks.database?.status === 'unavailable') return 'unavailable';
  return 'degraded';
}

// ── Routes ─────────────────────────────────────────────────────────

export const healthRoutes: FastifyPluginAsync = async (app) => {
  // Legacy endpoint — keep for backward compatibility
  app.get('/health', async () => {
    return { status: 'ok' };
  });

  // Liveness probe — always returns 200 if the process is running
  app.get('/health/live', async () => {
    return { status: 'ok' };
  });

  // Readiness probe — checks all critical dependencies concurrently
  app.get('/health/ready', async (_request, reply) => {
    const timeout = config.HEALTH_PROBE_TIMEOUT_MS;

    const [database, clerk, github, stripe] = await Promise.allSettled([
      probeDatabase(timeout),
      probeClerk(timeout),
      probeGitHub(timeout),
      probeStripe(timeout),
    ]);

    const checks: Record<string, CheckResult> = {
      database: settledValue(database, timeout),
      clerk: settledValue(clerk, timeout),
      github: settledValue(github, timeout),
      stripe: settledValue(stripe, timeout),
    };

    const status = deriveStatus(checks);

    const body: ReadinessResponse = {
      status,
      checks,
      version: appVersion,
      uptime: Math.round(process.uptime()),
    };

    const httpCode = status === 'ok' ? 200 : 503;

    if (status !== 'ok' && config.HEALTH_LOG_FAILURES) {
      app.log.warn({ checks }, 'Health readiness check failed');
    }

    return reply.code(httpCode).send(body);
  });
};

function settledValue(
  result: PromiseSettledResult<CheckResult>,
  timeoutMs: number,
): CheckResult {
  if (result.status === 'fulfilled') return result.value;
  return {
    status: 'unavailable',
    latencyMs: null,
    error: errorMessage(result.reason, timeoutMs),
  };
}
