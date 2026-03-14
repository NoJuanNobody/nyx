import { describe, it, expect, vi, beforeEach } from 'vitest';
import '../helpers/setup.js';
import Fastify from 'fastify';

vi.mock('../../middleware/permissions.js', () => ({
  requireRole: () => async () => {},
}));

const { mockSuggestionService } = vi.hoisted(() => ({
  mockSuggestionService: {
    generateSuggestions: vi.fn(),
    listByDocument: vi.fn(),
    approve: vi.fn(),
    dismiss: vi.fn(),
  },
}));

vi.mock('../../services/suggestion.service.js', () => ({
  suggestionService: mockSuggestionService,
}));

import { suggestionRoutes } from '../../routes/suggestions.js';

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
  app.register(suggestionRoutes, { prefix: '/api' });
  await app.ready();
  return app;
}

describe('Suggestion Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('POST /api/documents/:docId/suggest-tickets generates suggestions', async () => {
    const suggestion = { id: 'sug-1', tickets: [{ title: 'Add tests' }] };
    mockSuggestionService.generateSuggestions.mockResolvedValue(suggestion);

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/documents/doc-1/suggest-tickets' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBe('sug-1');
  });

  it('GET /api/documents/:docId/ticket-suggestions lists suggestions', async () => {
    const suggestions = [{ id: 'sug-1', status: 'pending' }];
    mockSuggestionService.listByDocument.mockResolvedValue(suggestions);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/documents/doc-1/ticket-suggestions' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(1);
  });

  it('POST /api/ticket-suggestions/:id/approve approves suggestion', async () => {
    const result = { id: 'sug-1', status: 'approved', ticketId: 'ticket-1' };
    mockSuggestionService.approve.mockResolvedValue(result);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/ticket-suggestions/sug-1/approve',
      payload: { provider: 'github' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('approved');
  });

  it('POST /api/ticket-suggestions/:id/dismiss dismisses suggestion', async () => {
    const result = { id: 'sug-1', status: 'dismissed' };
    mockSuggestionService.dismiss.mockResolvedValue(result);

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/ticket-suggestions/sug-1/dismiss' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('dismissed');
  });
});
