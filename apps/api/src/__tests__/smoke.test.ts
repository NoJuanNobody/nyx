import { describe, it, expect } from 'vitest';
import { buildTestApp, injectAs } from './helpers/app.js';
import { makeUser } from './helpers/factories.js';

// Re-usable test user for authenticated requests
const testUser = makeUser({
  id: 'smoke-user-1',
  email: 'smoke@test.com',
  name: 'Smoke Test',
});

describe('API Smoke Tests', () => {
  describe('Server bootstrap', () => {
    it('builds and starts without errors', async () => {
      const app = await buildTestApp();
      expect(app).toBeDefined();
      expect(typeof app.inject).toBe('function');
      await app.close();
    });
  });

  describe('Health endpoint', () => {
    it('GET /health returns 200 with status ok', async () => {
      const app = await buildTestApp();
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveProperty('status', 'ok');
      await app.close();
    });
  });

  describe('Auth endpoint', () => {
    it('GET /api/auth/me responds without server error', async () => {
      const app = await buildTestApp();
      const res = await injectAs(app, testUser as any, 'GET', '/api/auth/me');
      expect(res.statusCode).toBeLessThan(500);
      await app.close();
    });
  });

  describe('Documents endpoint', () => {
    it('GET /api/documents responds without server error', async () => {
      const app = await buildTestApp();
      const res = await injectAs(app, testUser as any, 'GET', '/api/documents?teamId=team-1');
      expect(res.statusCode).toBeLessThan(500);
      await app.close();
    });
  });

  describe('Teams endpoint', () => {
    it('GET /api/teams responds without server error', async () => {
      const app = await buildTestApp();
      const res = await injectAs(app, testUser as any, 'GET', '/api/teams');
      expect(res.statusCode).toBeLessThan(500);
      await app.close();
    });
  });

  describe('Templates endpoint', () => {
    it('GET /api/templates responds without server error', async () => {
      const app = await buildTestApp();
      const res = await injectAs(app, testUser as any, 'GET', '/api/templates');
      expect(res.statusCode).toBeLessThan(500);
      await app.close();
    });
  });

  describe('Unknown routes', () => {
    it('unknown routes do not cause a server error', async () => {
      const app = await buildTestApp();
      const res = await app.inject({ method: 'GET', url: '/nonexistent-route' });
      // Auth middleware may intercept (401) or route falls through (404) — either is fine
      expect(res.statusCode).toBeLessThan(500);
      await app.close();
    });

    it('unknown API routes do not cause a server error', async () => {
      const app = await buildTestApp();
      const res = await injectAs(app, testUser as any, 'GET', '/api/nonexistent-route');
      expect(res.statusCode).toBeLessThan(500);
      await app.close();
    });
  });

  describe('Unauthenticated requests', () => {
    it('GET /api/documents without auth token responds without server error', async () => {
      const app = await buildTestApp();
      const res = await app.inject({ method: 'GET', url: '/api/documents?teamId=team-1' });
      expect(res.statusCode).toBeLessThan(500);
      await app.close();
    });
  });
});
