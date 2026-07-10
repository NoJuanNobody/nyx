import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { redirectRoutes } from '../../routes/redirects.js';

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(redirectRoutes, { prefix: '/go' });
  await app.ready();
  return app;
}

describe('ad click redirect (/go/:slug)', () => {
  it('known slug → 302 to the landing page with UTM params', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/go/kb' });
    expect(res.statusCode).toBe(302);
    const loc = res.headers.location as string;
    expect(loc).toContain('https://nyx-creative.com/');
    expect(loc).toContain('utm_source=kickbacks');
    expect(loc).toContain('utm_medium=statusline');
    expect(loc).toContain('utm_campaign=kb_v1');
  });

  it('?s= overrides the utm_medium (e.g. terminal vs extension surface)', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/go/kb?s=terminal' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('utm_medium=terminal');
  });

  it('unknown slug → 302 to the homepage (never drop the visitor)', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/go/does-not-exist' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://nyx-creative.com/');
  });
});
