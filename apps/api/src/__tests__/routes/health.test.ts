import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { healthRoutes } from '../../routes/health.js';

async function buildHealthApp() {
  const app = Fastify({ logger: false });
  app.register(healthRoutes);
  await app.ready();
  return app;
}

describe('Health Routes', () => {
  it('GET /health returns 200 with status ok', async () => {
    const app = await buildHealthApp();
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
  });

  it('GET /health requires no auth', async () => {
    // No user decoration — request should still succeed
    const app = await buildHealthApp();
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
  });
});
