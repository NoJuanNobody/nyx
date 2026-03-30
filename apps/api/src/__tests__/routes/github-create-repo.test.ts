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
const mockCreateRepo = vi.fn();
const mockCreateWebhook = vi.fn();
vi.mock('../../services/github.service.js', () => {
  class GitHubTokenExpiredError extends Error {
    constructor(method: string) {
      super('GitHub token expired or revoked. Please reconnect your GitHub integration.');
      this.name = 'GitHubTokenExpiredError';
    }
  }
  return {
    GitHubTokenExpiredError,
    githubService: {
      listRepos: vi.fn(),
      exchangeCodeForToken: vi.fn(),
      getAuthenticatedUser: vi.fn(),
      createWebhook: (...args: unknown[]) => mockCreateWebhook(...args),
      deleteWebhook: vi.fn(),
      createRepo: (...args: unknown[]) => mockCreateRepo(...args),
    },
  };
});

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

describe('POST /api/integrations/:id/github/repos/create', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a repo and returns 201 with repo data', async () => {
    const integration = makeIntegration({
      id: 'int-1',
      type: 'github',
      config: { accessToken: 'ghp_valid_token', selectedRepos: [] },
    });

    const createdRepo = {
      id: 99,
      name: 'new-repo',
      full_name: 'testuser/new-repo',
      private: true,
      html_url: 'https://github.com/testuser/new-repo',
      default_branch: 'main',
    };

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([integration]),
      }),
    } as any);

    mockCreateRepo.mockResolvedValue(createdRepo);

    const app = await buildIntegrationApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations/int-1/github/repos/create',
      payload: { name: 'new-repo', description: 'A new project', isPrivate: true },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.repo.full_name).toBe('testuser/new-repo');
    expect(body.repo.name).toBe('new-repo');
    expect(mockCreateRepo).toHaveBeenCalledWith(
      'ghp_valid_token',
      'new-repo',
      'A new project',
      true,
      undefined,
    );
  });

  it('returns 400 when name is missing', async () => {
    const app = await buildIntegrationApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations/int-1/github/repos/create',
      payload: { description: 'no name' },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/name/i);
  });

  it('returns 400 when name has invalid characters', async () => {
    const app = await buildIntegrationApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations/int-1/github/repos/create',
      payload: { name: 'invalid repo name!' },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/invalid/i);
  });

  it('returns 404 when integration is not found', async () => {
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as any);

    const app = await buildIntegrationApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations/nonexistent/github/repos/create',
      payload: { name: 'my-repo' },
    });

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/not found/i);
  });

  it('returns 400 when access token is missing', async () => {
    const integration = makeIntegration({
      id: 'int-2',
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
      method: 'POST',
      url: '/api/integrations/int-2/github/repos/create',
      payload: { name: 'my-repo' },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/access token/i);
  });

  it('returns 422 when GitHub API returns a validation error', async () => {
    const integration = makeIntegration({
      id: 'int-3',
      type: 'github',
      config: { accessToken: 'ghp_valid_token', selectedRepos: [] },
    });

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([integration]),
      }),
    } as any);

    mockCreateRepo.mockRejectedValue(
      new Error('GitHub createRepo failed: name already exists on this account'),
    );

    const app = await buildIntegrationApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations/int-3/github/repos/create',
      payload: { name: 'existing-repo' },
    });

    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/already exists/i);
  });

  it('returns 401 when GitHub token is expired', async () => {
    const integration = makeIntegration({
      id: 'int-4',
      type: 'github',
      config: { accessToken: 'ghp_expired_token', selectedRepos: [] },
    });

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([integration]),
      }),
    } as any);

    // Import the mocked class
    const { GitHubTokenExpiredError } = await import('../../services/github.service.js');
    mockCreateRepo.mockRejectedValue(new GitHubTokenExpiredError('createRepo'));

    const app = await buildIntegrationApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations/int-4/github/repos/create',
      payload: { name: 'my-repo' },
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('github_token_expired');
  });

  it('adds created repo to selectedRepos and registers webhook', async () => {
    const integration = makeIntegration({
      id: 'int-5',
      type: 'github',
      config: { accessToken: 'ghp_valid_token', selectedRepos: [], webhookIds: {} },
    });

    const createdRepo = {
      id: 99,
      name: 'new-repo',
      full_name: 'testuser/new-repo',
      private: true,
      html_url: 'https://github.com/testuser/new-repo',
      default_branch: 'main',
    };

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([integration]),
      }),
    } as any);

    mockCreateRepo.mockResolvedValue(createdRepo);
    mockCreateWebhook.mockResolvedValue({ id: 42 });

    const app = await buildIntegrationApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations/int-5/github/repos/create',
      payload: { name: 'new-repo' },
    });

    expect(res.statusCode).toBe(201);

    // Verify webhook was registered
    expect(mockCreateWebhook).toHaveBeenCalledWith(
      'ghp_valid_token',
      'testuser',
      'new-repo',
      'https://test.example.com/api/webhooks/github',
      expect.any(String),
    );

    // Verify DB was updated with selectedRepos and webhookIds
    expect(mockDb.update).toHaveBeenCalled();
    const setCall = mockDb.update.mock.results[0]?.value?.set;
    expect(setCall).toBeDefined();
    const setArg = setCall.mock.calls[0][0];
    expect(setArg.config.selectedRepos).toEqual([
      { owner: 'testuser', name: 'new-repo', fullName: 'testuser/new-repo' },
    ]);
    expect(setArg.config.webhookIds).toEqual({ 'testuser/new-repo': 42 });
  });

  it('still adds repo to selectedRepos when webhook registration fails', async () => {
    const integration = makeIntegration({
      id: 'int-6',
      type: 'github',
      config: { accessToken: 'ghp_valid_token', selectedRepos: [], webhookIds: {} },
    });

    const createdRepo = {
      id: 100,
      name: 'another-repo',
      full_name: 'testuser/another-repo',
      private: false,
      html_url: 'https://github.com/testuser/another-repo',
      default_branch: 'main',
    };

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([integration]),
      }),
    } as any);

    mockCreateRepo.mockResolvedValue(createdRepo);
    mockCreateWebhook.mockRejectedValue(new Error('Webhook creation failed'));

    const app = await buildIntegrationApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations/int-6/github/repos/create',
      payload: { name: 'another-repo' },
    });

    expect(res.statusCode).toBe(201);

    // Verify DB was still updated with selectedRepos (but no webhookId)
    expect(mockDb.update).toHaveBeenCalled();
    const setCall = mockDb.update.mock.results[0]?.value?.set;
    const setArg = setCall.mock.calls[0][0];
    expect(setArg.config.selectedRepos).toEqual([
      { owner: 'testuser', name: 'another-repo', fullName: 'testuser/another-repo' },
    ]);
    expect(setArg.config.webhookIds).toEqual({});
  });

  it('does not duplicate repo in selectedRepos if already present', async () => {
    const integration = makeIntegration({
      id: 'int-7',
      type: 'github',
      config: {
        accessToken: 'ghp_valid_token',
        selectedRepos: [{ owner: 'testuser', name: 'new-repo', fullName: 'testuser/new-repo' }],
        webhookIds: { 'testuser/new-repo': 10 },
      },
    });

    const createdRepo = {
      id: 99,
      name: 'new-repo',
      full_name: 'testuser/new-repo',
      private: true,
      html_url: 'https://github.com/testuser/new-repo',
      default_branch: 'main',
    };

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([integration]),
      }),
    } as any);

    mockCreateRepo.mockResolvedValue(createdRepo);

    const app = await buildIntegrationApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations/int-7/github/repos/create',
      payload: { name: 'new-repo' },
    });

    expect(res.statusCode).toBe(201);

    // Should not register another webhook since one already exists
    expect(mockCreateWebhook).not.toHaveBeenCalled();

    // Verify selectedRepos still has only one entry
    const setCall = mockDb.update.mock.results[0]?.value?.set;
    const setArg = setCall.mock.calls[0][0];
    expect(setArg.config.selectedRepos).toHaveLength(1);
  });
});
