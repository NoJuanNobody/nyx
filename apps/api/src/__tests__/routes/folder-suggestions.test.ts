import { describe, it, expect, vi, beforeEach } from 'vitest';
import '../helpers/setup.js';
import Fastify from 'fastify';

vi.mock('../../middleware/permissions.js', () => ({
  requireRole: () => async () => {},
}));

const { mockSuggestionService, mockJobService } = vi.hoisted(() => ({
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
  mockJobService: {
    create: vi.fn().mockResolvedValue({ id: 'job-1' }),
    markRunning: vi.fn().mockResolvedValue({}),
    markCompleted: vi.fn().mockResolvedValue({}),
    markFailed: vi.fn().mockResolvedValue({}),
    listByTeam: vi.fn().mockResolvedValue([]),
    getById: vi.fn().mockResolvedValue(null),
    updateProgress: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../../services/suggestion.service.js', () => ({
  suggestionService: mockSuggestionService,
}));

vi.mock('../../services/job.service.js', () => ({
  jobService: mockJobService,
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

    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.jobId).toBe('job-1');
    expect(mockJobService.create).toHaveBeenCalledWith('team-1', 'user-1', 'folder-suggest-tickets', { teamId: 'team-1', folderPath: '/specs' });
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

  it('returns 202 and marks job failed when no documents found in folder', async () => {
    mockSuggestionService.generateFolderSuggestions.mockRejectedValue(
      new Error('No documents found in this folder'),
    );

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/folders/suggest-tickets',
      payload: { teamId: 'team-1', folderPath: '/empty-folder' },
    });

    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.jobId).toBe('job-1');

    // Wait for setImmediate to process the async work
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockJobService.markFailed).toHaveBeenCalledWith('job-1', 'No documents found in this folder');
  });
});
