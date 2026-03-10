import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDb } from '../helpers/setup.js';
import { createHmac } from 'node:crypto';
import Fastify from 'fastify';
import { webhookRoutes } from '../../routes/webhooks.js';

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: async () => {},
}));

vi.mock('../../services/ai.service.js', () => ({
  aiService: { detectDrift: vi.fn().mockResolvedValue({ hasDrift: false }) },
}));

vi.mock('../../services/github.service.js', () => ({
  githubService: {
    handlePushWebhook: vi.fn().mockReturnValue({
      ref: 'refs/heads/main',
      commits: [{ id: 'abc', message: 'fix', timestamp: '2025-01-01', author: { name: 'Dev', email: 'd@t.com' } }],
      changedFiles: ['src/app.ts'],
    }),
  },
}));

vi.mock('../../services/timeline.service.js', () => ({
  timelineService: { create: vi.fn().mockResolvedValue({}) },
}));

vi.mock('../../services/audit.service.js', () => ({
  auditService: { recordEvent: vi.fn().mockResolvedValue({}) },
}));

function signPayload(payload: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
}

async function buildWebhookApp() {
  const app = Fastify({ logger: false });
  app.decorateRequest('user', null as any);
  app.register(webhookRoutes, { prefix: '/api/webhooks' });
  await app.ready();
  return app;
}

describe('Webhook Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('valid HMAC signature → processes webhook', async () => {
    const body = JSON.stringify({ ref: 'refs/heads/main', commits: [], repository: { full_name: 'org/repo' } });
    const signature = signPayload(body, 'test-webhook-secret');

    // Integration lookup returns empty (falls back to global secret)
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as any);

    const app = await buildWebhookApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      payload: body,
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'push',
        'x-hub-signature-256': signature,
      },
    });

    expect(res.statusCode).toBe(200);
    const result = JSON.parse(res.body);
    expect(result.ok).toBe(true);
  });

  it('invalid signature → 401', async () => {
    const body = JSON.stringify({ ref: 'refs/heads/main', commits: [], repository: { full_name: 'org/repo' } });

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as any);

    const app = await buildWebhookApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      payload: body,
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'push',
        'x-hub-signature-256': 'sha256=invalidsignature',
      },
    });

    expect(res.statusCode).toBe(401);
  });

  it('per-integration secret takes priority over global secret', async () => {
    const integrationSecret = 'per-integration-secret';
    const body = JSON.stringify({ ref: 'refs/heads/main', commits: [], repository: { full_name: 'org/repo' } });
    const signature = signPayload(body, integrationSecret);

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          {
            id: 'int-1',
            teamId: 'team-1',
            type: 'github',
            config: {
              selectedRepos: [{ fullName: 'org/repo' }],
              webhookSecret: integrationSecret,
            },
          },
        ]),
      }),
    } as any);

    const app = await buildWebhookApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      payload: body,
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'push',
        'x-hub-signature-256': signature,
      },
    });

    expect(res.statusCode).toBe(200);
  });

  it('missing signature in production → 401', async () => {
    // The config mock has GITHUB_WEBHOOK_SECRET set, so missing signature → 401
    const body = JSON.stringify({ ref: 'refs/heads/main', commits: [], repository: { full_name: 'org/repo' } });

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as any);

    const app = await buildWebhookApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      payload: body,
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'push',
        // No x-hub-signature-256 header
      },
    });

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toContain('Missing webhook signature');
  });

  it('push event triggers processing (returns result)', async () => {
    const body = JSON.stringify({ ref: 'refs/heads/main', commits: [], repository: { full_name: 'org/repo' } });
    const signature = signPayload(body, 'test-webhook-secret');

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as any);

    const app = await buildWebhookApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      payload: body,
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'push',
        'x-hub-signature-256': signature,
      },
    });

    const result = JSON.parse(res.body);
    expect(result.ok).toBe(true);
    expect(result.ref).toBe('refs/heads/main');
    expect(result.changedFiles).toContain('src/app.ts');
  });
});
