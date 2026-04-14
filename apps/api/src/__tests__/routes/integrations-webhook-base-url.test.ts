/**
 * Tests for the WEBHOOK_BASE_URL "silent disconnect" fix (#334).
 *
 * Two key behaviors:
 *   1. When WEBHOOK_BASE_URL is unset, PUT /api/integrations/:id/github/repos
 *      must NOT call createWebhook, must report skipped repos in the response,
 *      and the integration's webhookIds must remain empty (causing every repo
 *      to render as "Disconnected" / "Sync disabled").
 *
 *   2. POST /api/integrations/:id/github/repos/:repoName/reconnect must call
 *      createWebhook, persist the new id, and return syncStatus: 'active'
 *      when WEBHOOK_BASE_URL is set.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDb } from '../helpers/setup.js';
import { makeIntegration } from '../helpers/factories.js';
import Fastify from 'fastify';

// Permissions middleware: let everything through.
vi.mock('../../middleware/permissions.js', () => ({
  requireRole: () => async () => {},
}));

// Allow each test to control config.WEBHOOK_BASE_URL by mutating this object.
const mockConfig: Record<string, unknown> = {
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  PORT: 3001,
  HOST: '0.0.0.0',
  NODE_ENV: 'test',
  WEBHOOK_BASE_URL: undefined as string | undefined,
  CLERK_SECRET_KEY: 'test-clerk-secret',
};

vi.mock('../../lib/config.js', () => ({
  get config() {
    return mockConfig;
  },
}));

// GitHub service mocks
const mockCreateWebhook = vi.fn();
const mockDeleteWebhook = vi.fn();
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
      createRepo: vi.fn(),
      createWebhook: (...args: unknown[]) => mockCreateWebhook(...args),
      deleteWebhook: (...args: unknown[]) => mockDeleteWebhook(...args),
    },
  };
});

vi.mock('../../services/jira.service.js', () => ({
  jiraService: {
    listProjects: vi.fn(),
  },
}));

async function buildIntegrationApp() {
  const { integrationRoutes } = await import('../../routes/integrations.js');
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

describe('PUT /api/integrations/:id/github/repos with WEBHOOK_BASE_URL unset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.WEBHOOK_BASE_URL = undefined;
  });

  it('skips webhook registration silently and reports skipped repos in the response', async () => {
    const integration = makeIntegration({
      id: 'int-1',
      type: 'github',
      config: {
        accessToken: 'ghp_valid_token',
        selectedRepos: [],
        webhookIds: {},
      },
    });

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([integration]),
      }),
    } as any);

    const updateSet = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([integration]),
    });
    mockDb.update.mockReturnValue({ set: updateSet } as any);

    const app = await buildIntegrationApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/integrations/int-1/github/repos',
      payload: {
        repos: [
          { owner: 'org', name: 'repo-a', fullName: 'org/repo-a' },
          { owner: 'org', name: 'repo-b', fullName: 'org/repo-b' },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    // Webhook creation must not have been attempted at all.
    expect(mockCreateWebhook).not.toHaveBeenCalled();

    // Response must surface the disabled-mode flag and which repos were skipped
    // (NOT failed — failed implies an attempt that errored).
    expect(body.ok).toBe(true);
    expect(body.webhookRegistrationEnabled).toBe(false);
    expect(body.failed).toEqual([]);
    expect(body.skipped).toEqual(['org/repo-a', 'org/repo-b']);

    // Persisted config: webhookIds must remain empty so synced-repos endpoint
    // computes syncStatus='disconnected' for every repo.
    const persisted = updateSet.mock.calls[0][0];
    expect(persisted.config.webhookIds).toEqual({});
    expect(persisted.config.selectedRepos).toHaveLength(2);
  });

  it('GET /:id/github/synced-repos exposes webhookRegistrationEnabled=false', async () => {
    const integration = makeIntegration({
      id: 'int-2',
      type: 'github',
      teamId: 'team-1',
      config: {
        accessToken: 'ghp_valid_token',
        selectedRepos: [{ owner: 'org', name: 'repo-a', fullName: 'org/repo-a' }],
        webhookIds: {},
      },
    });

    // First call: load integration. Subsequent calls (documents, timeline events)
    // — return empty arrays so the enrichment loop runs cleanly.
    mockDb.select
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([integration]),
        }),
      } as any)
      .mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as any);

    const app = await buildIntegrationApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/integrations/int-2/github/synced-repos',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.webhookRegistrationEnabled).toBe(false);
    expect(body.repos).toHaveLength(1);
    expect(body.repos[0].syncStatus).toBe('disconnected');
  });
});

describe('POST /api/integrations/:id/github/repos/:repoName/reconnect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.WEBHOOK_BASE_URL = 'https://api.example.com';
  });

  it('registers a webhook and flips the persisted state to active when the env is set', async () => {
    const integration = makeIntegration({
      id: 'int-1',
      type: 'github',
      config: {
        accessToken: 'ghp_valid_token',
        selectedRepos: [
          { owner: 'org', name: 'repo-a', fullName: 'org/repo-a' },
        ],
        webhookIds: {}, // currently disconnected
        webhookSecret: 'preexisting-secret',
      },
    });

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([integration]),
      }),
    } as any);

    const updateSet = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([integration]),
    });
    mockDb.update.mockReturnValue({ set: updateSet } as any);

    mockCreateWebhook.mockResolvedValue({ id: 4242 });

    const app = await buildIntegrationApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations/int-1/github/repos/org%2Frepo-a/reconnect',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.fullName).toBe('org/repo-a');
    expect(body.webhookId).toBe(4242);
    expect(body.syncStatus).toBe('active');

    // Reused the helper: createWebhook called with the configured base URL.
    expect(mockCreateWebhook).toHaveBeenCalledWith(
      'ghp_valid_token',
      'org',
      'repo-a',
      'https://api.example.com/api/webhooks/github',
      'preexisting-secret',
    );

    // Persisted webhookIds now contains the new id.
    const persisted = updateSet.mock.calls[0][0];
    expect(persisted.config.webhookIds).toEqual({ 'org/repo-a': 4242 });
  });

  it('returns 503 with structured error when WEBHOOK_BASE_URL is unset', async () => {
    mockConfig.WEBHOOK_BASE_URL = undefined;

    const integration = makeIntegration({
      id: 'int-1',
      type: 'github',
      config: {
        accessToken: 'ghp_valid_token',
        selectedRepos: [
          { owner: 'org', name: 'repo-a', fullName: 'org/repo-a' },
        ],
        webhookIds: {},
      },
    });

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([integration]),
      }),
    } as any);

    const app = await buildIntegrationApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations/int-1/github/repos/org%2Frepo-a/reconnect',
    });

    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('webhook_registration_disabled');
    expect(body.message).toMatch(/WEBHOOK_BASE_URL/);
    expect(mockCreateWebhook).not.toHaveBeenCalled();
  });

  it('returns 502 with structured error when GitHub createWebhook throws', async () => {
    const integration = makeIntegration({
      id: 'int-1',
      type: 'github',
      config: {
        accessToken: 'ghp_valid_token',
        selectedRepos: [
          { owner: 'org', name: 'repo-a', fullName: 'org/repo-a' },
        ],
        webhookIds: {},
      },
    });

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([integration]),
      }),
    } as any);

    mockCreateWebhook.mockRejectedValue(new Error('GitHub createWebhook failed: 422 Unprocessable'));

    const app = await buildIntegrationApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/integrations/int-1/github/repos/org%2Frepo-a/reconnect',
    });

    expect(res.statusCode).toBe(502);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('webhook_creation_failed');
    expect(body.message).toMatch(/422/);
  });
});
