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
const mockDeleteWebhook = vi.fn();
vi.mock('../../services/github.service.js', () => ({
  githubService: {
    listRepos: vi.fn(),
    exchangeCodeForToken: vi.fn(),
    getAuthenticatedUser: vi.fn(),
    createWebhook: vi.fn(),
    deleteWebhook: (...args: unknown[]) => mockDeleteWebhook(...args),
  },
}));

// Mock jira service (imported by integrations route)
vi.mock('../../services/jira.service.js', () => ({
  jiraService: {
    listProjects: vi.fn(),
  },
}));

async function buildApp() {
  const app = Fastify({ logger: false });

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

describe('GET /api/integrations/:id/github/synced-repos', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns enriched repos when integration has selected repos', async () => {
    const integration = makeIntegration({
      id: 'int-1',
      teamId: 'team-1',
      type: 'github',
      config: {
        accessToken: 'ghp_valid_token',
        selectedRepos: [
          { owner: 'org', name: 'repo-a', fullName: 'org/repo-a' },
          { owner: 'org', name: 'repo-b', fullName: 'org/repo-b' },
        ],
        webhookIds: { 'org/repo-a': 12345 },
      },
    });

    // First call: integration lookup
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([integration]),
      }),
    } as any);

    // Second call: documents lookup
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as any);

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/integrations/int-1/github/synced-repos',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.repos).toHaveLength(2);
    expect(body.repos[0].fullName).toBe('org/repo-a');
    expect(body.repos[0].syncStatus).toBe('active');
    expect(body.repos[1].fullName).toBe('org/repo-b');
    expect(body.repos[1].syncStatus).toBe('disconnected');
  });

  it('returns empty array when no repos are selected', async () => {
    const integration = makeIntegration({
      id: 'int-2',
      type: 'github',
      config: { accessToken: 'ghp_valid_token', selectedRepos: [] },
    });

    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([integration]),
      }),
    } as any);

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/integrations/int-2/github/synced-repos',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.repos).toHaveLength(0);
  });

  it('returns 404 when integration does not exist', async () => {
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as any);

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/integrations/nonexistent/github/synced-repos',
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns 404 when integration is not github type', async () => {
    const integration = makeIntegration({
      id: 'int-3',
      type: 'jira',
      config: { baseUrl: 'https://jira.example.com' },
    });

    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([integration]),
      }),
    } as any);

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/integrations/int-3/github/synced-repos',
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /api/integrations/:id/github/repos/:repoName', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('removes a repo and deletes its webhook', async () => {
    const integration = makeIntegration({
      id: 'int-1',
      type: 'github',
      config: {
        accessToken: 'ghp_valid_token',
        selectedRepos: [
          { owner: 'org', name: 'repo-a', fullName: 'org/repo-a' },
          { owner: 'org', name: 'repo-b', fullName: 'org/repo-b' },
        ],
        webhookIds: { 'org/repo-a': 12345, 'org/repo-b': 67890 },
        webhookSecret: 'secret',
      },
    });

    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([integration]),
      }),
    } as any);

    mockDb.update.mockReturnValueOnce({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as any);

    mockDeleteWebhook.mockResolvedValue(undefined);

    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/integrations/int-1/github/repos/${encodeURIComponent('org/repo-a')}`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(mockDeleteWebhook).toHaveBeenCalledWith('ghp_valid_token', 'org', 'repo-a', 12345);
  });

  it('returns 404 when repo is not in synced repos', async () => {
    const integration = makeIntegration({
      id: 'int-2',
      type: 'github',
      config: {
        accessToken: 'ghp_valid_token',
        selectedRepos: [{ owner: 'org', name: 'repo-a', fullName: 'org/repo-a' }],
        webhookIds: {},
      },
    });

    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([integration]),
      }),
    } as any);

    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/integrations/int-2/github/repos/${encodeURIComponent('org/nonexistent')}`,
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns 404 when integration does not exist', async () => {
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as any);

    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/integrations/nonexistent/github/repos/${encodeURIComponent('org/repo')}`,
    });

    expect(res.statusCode).toBe(404);
  });
});
