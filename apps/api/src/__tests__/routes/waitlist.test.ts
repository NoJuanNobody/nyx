import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDb } from '../helpers/setup.js';
import Fastify from 'fastify';
import { waitlistRoutes } from '../../routes/waitlist.js';

vi.mock('../../db/schema.js', () => ({
  waitlistSignups: {},
}));

async function buildApp() {
  const app = Fastify({ logger: false });
  app.register(waitlistRoutes, { prefix: '/api/waitlist' });
  await app.ready();
  return app;
}

describe('POST /api/waitlist', () => {
  beforeEach(() => {
    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      }),
    } as any);
  });

  it('returns 201 { ok: true } for a valid email', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/waitlist',
      payload: { email: 'test@example.com' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ ok: true });
  });

  it('returns 400 for an invalid email', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/waitlist',
      payload: { email: 'invalid' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when email is missing', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/waitlist',
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });
});
