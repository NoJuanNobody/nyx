import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDb } from '../helpers/setup.js';
import { makeIntegration } from '../helpers/factories.js';
import Fastify from 'fastify';
import { integrationRoutes } from '../../routes/integrations.js';

// Mock permissions middleware to let requests through
vi.mock('../../middleware/permissions.js', () => ({
  requireRole: () => async () => {},
}));

// Mock github service — make listRepos throw GitHubTokenExpiredError
const { GitHubTokenExpiredError } = await import('../../services/github.service.js');

const mockListRepos = vi.fn();
const mockCreateWebhook = vi.fn();
const mockDeleteWebhook = vi.fn();
vi.mock('../../services/github.service.js', async () => {
  class GitHubTokenExpiredError extends Error {
    constructor(method: string) {
      super('GitHub token expired or revoked. Please reconnect your GitHub integration.');
      this.name = 'GitHubTokenExpiredError';
    }
  }
  return {
    GitHubTokenExpiredError,
    githubService: {
      listRepos: (...args: unknown[]) => mockListRepos(...args),
      exchangeCodeForToken: vi.fn(),
      getAuthenticatedUser: vi.fn(),
      createWebhook: (...args: unknown[]) => mockCreateWebhook(...args),
      deleteWebhook: (...args: unknown[]) => mockDeleteWebhook(...args),
    },
  };
});

// Mock jira service
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

describe('GitHub token expired route handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET /github/repos returns 401 with github_token_expired on expired token', async () => {
    const integration = makeIntegration({
      id: 'int-1',
      type: 'github',
      config: { accessToken: 'expired_token', selectedRepos: [] },
    });

    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([integration]),
      }),
    } as any);

    // Import the actual class from the mocked module
    const { GitHubTokenExpiredError: MockedError } = await import('../../services/github.service.js');
    mockListRepos.mockRejectedValue(new MockedError('listRepos'));

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/integrations/int-1/github/repos',
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('github_token_expired');
    expect(body.message).toMatch(/reconnect/i);
  });

  it('POST /test returns 401 with github_token_expired on expired token', async () => {
    const integration = makeIntegration({
      id: 'int-2',
      type: 'github',
      config: { accessToken: 'expired_token' },
    });

    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([integration]),
      }),
    } as any);

    const { GitHubTokenExpiredError: MockedError } = await import('../../services/github.service.js');
    mockListRepos.mockRejectedValue(new MockedError('listRepos'));

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations/int-2/test',
      payload: {},
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('github_token_expired');
  });
});
