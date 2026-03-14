import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { healthRoutes } from '../../routes/health.js';

async function buildApp() {
  const app = Fastify({ logger: false });
  app.register(healthRoutes);
  await app.ready();
  return app;
}

describe('GET /health', () => {
  it('returns { status: "ok" } with 200', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});
