import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDb } from '../helpers/setup.js';
import Fastify from 'fastify';
import { mockupRoutes, setMockupCluster } from '../../routes/mockups.js';

vi.mock('../../middleware/permissions.js', () => ({ requireRole: () => async () => {} }));
vi.mock('../../services/mockup.service.js', () => ({
  generateMockupHTML: vi.fn(),
  renderToScreenshot: vi.fn(),
  renderJSXToScreenshot: vi.fn().mockResolvedValue(Buffer.from('screenshot')),
  generateAndAttach: vi.fn().mockResolvedValue({ html: '<div/>', screenshot: Buffer.from('png') }),
}));
vi.mock('../../services/github.service.js', () => ({
  githubService: { attachImageToIssue: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../../services/jira.service.js', () => ({
  jiraService: { attachFileToIssue: vi.fn().mockResolvedValue(undefined) },
}));

async function buildApp() {
  const app = Fastify({ logger: false });
  app.decorateRequest('user', null as any);
  app.addHook('preHandler', async (request) => {
    request.user = { id: 'user-1', clerkId: 'clerk_1', email: 'test@test.com', name: 'Test User', avatarUrl: null, role: 'admin' } as any;
  });
  app.register(mockupRoutes, { prefix: '/api/mockups' });
  await app.ready();
  return app;
}

describe('Mockup Routes', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('POST /api/mockups/generate returns 503 when cluster not available', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST', url: '/api/mockups/generate',
      payload: { description: 'A login page', teamId: 'team-1' },
    });
    expect(res.statusCode).toBe(503);
  });

  it('POST /api/mockups/generate returns 400 without description', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST', url: '/api/mockups/generate',
      payload: { teamId: 'team-1' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/mockups/render-jsx returns 503 when cluster not available', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST', url: '/api/mockups/render-jsx',
      payload: { jsx: '<div>Hello</div>' },
    });
    expect(res.statusCode).toBe(503);
  });

  it('POST /api/mockups/render-jsx returns 400 without jsx', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST', url: '/api/mockups/render-jsx',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/mockups/attach-image returns 400 without required fields', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST', url: '/api/mockups/attach-image',
      payload: { screenshot: 'data:image/png;base64,abc' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/mockups/attach-image returns 400 without integration', async () => {
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          then: (cb: Function) => cb([]),
        }),
      }),
    } as any);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST', url: '/api/mockups/attach-image',
      payload: { screenshot: 'data:image/png;base64,abc', provider: 'github', issueId: '1', teamId: 'team-1' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/mockups/attach returns 503 when cluster not available', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST', url: '/api/mockups/attach',
      payload: { description: 'A page', provider: 'github', issueId: '1', teamId: 'team-1' },
    });
    expect(res.statusCode).toBe(503);
  });

  it('POST /api/mockups/attach returns 400 without required fields', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST', url: '/api/mockups/attach',
      payload: { description: 'A page' },
    });
    expect(res.statusCode).toBe(400);
  });
});
