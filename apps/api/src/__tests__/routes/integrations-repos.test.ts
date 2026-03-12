import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDb } from '../helpers/setup.js';
import { makeIntegration } from '../helpers/factories.js';
import Fastify from 'fastify';
import { integrationRoutes } from '../../routes/integrations.js';

// Mock permissions middleware to let requests through
vi.mock('../../middleware/permissions.js', () => ({
  requireRole: () => async () => {},
}));

// Mock github service
const mockListRepos = vi.fn();
vi.mock('../../services/github.service.js', () => ({
  githubService: {
    listRepos: (...args: unknown[]) => mockListRepos(...args),
    exchangeCodeForToken: vi.fn(),
    getAuthenticatedUser: vi.fn(),
    createWebhook: vi.fn(),
    deleteWebhook: vi.fn(),
  },
}));

// Mock jira service (imported by integrations route)
vi.mock('../../services/jira.service.js', () => ({
  jiraService: {
    listProjects: vi.fn(),
  },
}));

async function buildIntegrationApp() {
  const app = Fastify({ logger: false });

  // Decorate request with a test user
  app.decorateRequest('user', null as any);
  app.addHook('preHandler', async (request) => {
    request.user = {
      id: 'user-1',
      clerkId: null,
      email: 'test@test.com',
      name: 'Test User',
      avatarUrl: null,
      role: 'admin',
    } as any;
  });

  app.register(integrationRoutes, { prefix: '/api/integrations' });
  await app.ready();
  return app;
}

describe('GET /api/integrations/:id/github/repos', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns repos when integration has a valid access token', async () => {
    const integration = makeIntegration({
      id: 'int-1',
      type: 'github',
      config: { accessToken: 'ghp_valid_token', selectedRepos: [] },
    });

    const sampleRepos = [
      { id: 1, name: 'repo-a', full_name: 'org/repo-a', private: false, html_url: 'https://github.com/org/repo-a', default_branch: 'main' },
      { id: 2, name: 'repo-b', full_name: 'org/repo-b', private: true, html_url: 'https://github.com/org/repo-b', default_branch: 'main' },
    ];

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([integration]),
      }),
    } as any);

    mockListRepos.mockResolvedValue(sampleRepos);

    const app = await buildIntegrationApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/integrations/int-1/github/repos',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.repos).toHaveLength(2);
    expect(body.repos[0].full_name).toBe('org/repo-a');
    expect(body.repos[1].full_name).toBe('org/repo-b');
    expect(mockListRepos).toHaveBeenCalledWith('ghp_valid_token');
  });

  it('returns 404 when integration does not exist', async () => {
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as any);

    const app = await buildIntegrationApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/integrations/nonexistent-id/github/repos',
    });

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/not found/i);
  });

  it('returns 502 when GitHub API call fails', async () => {
    const integration = makeIntegration({
      id: 'int-2',
      type: 'github',
      config: { accessToken: 'ghp_valid_token', selectedRepos: [] },
    });

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([integration]),
      }),
    } as any);

    mockListRepos.mockRejectedValue(new Error('GitHub listRepos failed: 401 Unauthorized'));

    const app = await buildIntegrationApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/integrations/int-2/github/repos',
    });

    expect(res.statusCode).toBe(502);
    const body = JSON.parse(res.body);
    expect(body.error).toBeDefined();
  });

  it('returns error when accessToken is missing from config', async () => {
    const integration = makeIntegration({
      id: 'int-3',
      type: 'github',
      config: { selectedRepos: [] }, // no accessToken
    });

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([integration]),
      }),
    } as any);

    const app = await buildIntegrationApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/integrations/int-3/github/repos',
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/access token/i);
  });

  it('returns 404 when integration type is not github', async () => {
    const integration = makeIntegration({
      id: 'int-4',
      type: 'jira',
      config: { baseUrl: 'https://jira.example.com' },
    });

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([integration]),
      }),
    } as any);

    const app = await buildIntegrationApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/integrations/int-4/github/repos',
    });

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/not found/i);
  });
});
