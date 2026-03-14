import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDb } from '../helpers/setup.js';
import Fastify from 'fastify';

const { mockFeedbackService } = vi.hoisted(() => ({
  mockFeedbackService: {
    formatFeedback: vi.fn(),
    checkRateLimit: vi.fn(),
    submitToGitHub: vi.fn(),
    saveFeedback: vi.fn(),
  },
}));

vi.mock('../../services/feedback.service.js', () => ({
  feedbackService: mockFeedbackService,
}));

import { feedbackRoutes } from '../../routes/feedback.js';

async function buildApp() {
  const app = Fastify({ logger: false });
  app.decorateRequest('user', null as any);
  app.addHook('preHandler', async (request) => {
    request.user = {
      id: 'user-1',
      clerkId: 'clerk_1',
      email: 'test@test.com',
      name: 'Test User',
      avatarUrl: null,
      role: 'admin',
    } as any;
  });
  app.register(feedbackRoutes, { prefix: '/api/feedback' });
  await app.ready();
  return app;
}

describe('Feedback Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('POST /api/feedback/format returns formatted feedback', async () => {
    const formatted = { title: 'Bug Report', body: 'Formatted body', category: 'bug' };
    mockFeedbackService.formatFeedback.mockResolvedValue(formatted);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/feedback/format',
      payload: { message: 'hello' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.title).toBe('Bug Report');
  });

  it('POST /api/feedback/format with empty message returns 400', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/feedback/format',
      payload: { message: '' },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBeDefined();
  });

  it('POST /api/feedback/submit with valid body returns id and githubIssueUrl', async () => {
    mockFeedbackService.checkRateLimit.mockResolvedValue({ allowed: true, remaining: 4 });
    mockFeedbackService.submitToGitHub.mockResolvedValue({
      issueUrl: 'https://github.com/issues/1',
      issueNumber: 1,
    });
    mockFeedbackService.saveFeedback.mockResolvedValue({ id: 'fb-1' });

    // Mock db.select for user lookup
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ id: 'user-1', name: 'Test User', email: 'test@test.com' }]),
      }),
    } as any);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/feedback/submit',
      payload: {
        rawMessage: 'raw',
        title: 'Bug Report',
        body: 'Description',
        category: 'bug',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBe('fb-1');
    expect(body.githubIssueUrl).toBe('https://github.com/issues/1');
  });

  it('POST /api/feedback/submit returns 429 when rate limited', async () => {
    mockFeedbackService.checkRateLimit.mockResolvedValue({ allowed: false, remaining: 0 });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/feedback/submit',
      payload: {
        rawMessage: 'raw',
        title: 'Bug Report',
        body: 'Description',
        category: 'bug',
      },
    });

    expect(res.statusCode).toBe(429);
  });
});
