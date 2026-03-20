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
    generateBulkSuggestions: vi.fn(),
    bulkApprove: vi.fn(),
    updateSuggestion: vi.fn(),
    generateFolderSuggestions: vi.fn(),
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

describe('Folder Suggestion Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('POST /api/folders/suggest-tickets generates suggestions for a folder', async () => {
    const suggestions = [
      { id: 'sug-1', title: '[M] Review API contracts', description: 'Review all API contracts', labels: ['spec-review'] },
      { id: 'sug-2', title: '[S] Add missing tests', description: 'Add unit tests', labels: ['enhancement'] },
    ];
    mockSuggestionService.generateFolderSuggestions.mockResolvedValue(suggestions);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/folders/suggest-tickets',
      payload: { teamId: 'team-1', folderPath: '/specs' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(2);
    expect(body[0].id).toBe('sug-1');
    expect(mockSuggestionService.generateFolderSuggestions).toHaveBeenCalledWith('team-1', '/specs');
  });

  it('returns 400 when teamId is missing', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/folders/suggest-tickets',
      payload: { folderPath: '/specs' },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('teamId is required');
  });

  it('returns 400 when folderPath is missing', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/folders/suggest-tickets',
      payload: { teamId: 'team-1' },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('folderPath is required');
  });

  it('returns 400 when no documents found in folder', async () => {
    mockSuggestionService.generateFolderSuggestions.mockRejectedValue(
      new Error('No documents found in this folder'),
    );

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/folders/suggest-tickets',
      payload: { teamId: 'team-1', folderPath: '/empty-folder' },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('No documents found in this folder');
  });
});
