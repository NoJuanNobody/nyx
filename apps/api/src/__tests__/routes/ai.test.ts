import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDb } from '../helpers/setup.js';
import Fastify from 'fastify';
import { aiRoutes } from '../../routes/ai.js';

vi.mock('../../db/schema.js', () => ({
  documents: { id: 'id', teamId: 'teamId', status: 'status' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => args),
}));

const mockAiService = vi.hoisted(() => ({
  analyzeSpecQuality: vi.fn(),
  detectDrift: vi.fn(),
  generateDocument: vi.fn(),
  editDocument: vi.fn(),
  generateTicketFromDiff: vi.fn(),
  generateJSXPreview: vi.fn(),
  refineJSXPreview: vi.fn(),
  seedNextStage: vi.fn(),
  analyzeMissingSections: vi.fn(),
  notificationReply: vi.fn(),
}));
vi.mock('../../services/ai.service.js', () => ({ aiService: mockAiService }));
vi.mock('../../middleware/permissions.js', () => ({ requireRole: () => async () => {} }));

async function buildApp() {
  const app = Fastify({ logger: false });
  app.decorateRequest('user', null as any);
  app.addHook('preHandler', async (request) => {
    request.user = { id: 'user-1', clerkId: 'clerk_1', email: 'test@test.com', name: 'Test User', avatarUrl: null, role: 'admin' } as any;
  });
  app.register(aiRoutes, { prefix: '/api/ai' });
  await app.ready();
  return app;
}

describe('AI Routes', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('POST /api/ai/analyze returns quality analysis', async () => {
    mockAiService.analyzeSpecQuality.mockResolvedValueOnce({ score: 8, suggestions: ['Good'] });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/ai/analyze', payload: { content: '# Spec' } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).score).toBe(8);
  });

  it('POST /api/ai/detect-drift returns drift result', async () => {
    mockAiService.detectDrift.mockResolvedValueOnce({ hasDrift: true, driftScore: 7, suggestions: [] });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/ai/detect-drift', payload: { specContent: 'spec', codeContent: 'code' } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).hasDrift).toBe(true);
  });

  it('POST /api/ai/generate-document returns generated doc', async () => {
    mockAiService.generateDocument.mockResolvedValueOnce('# Generated Doc');
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/ai/generate-document', payload: { prompt: 'Create a spec' } });
    expect(res.statusCode).toBe(200);
  });

  it('POST /api/ai/edit-document returns edited content', async () => {
    mockAiService.editDocument.mockResolvedValueOnce('# Edited');
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/ai/edit-document', payload: { content: '# Old', instruction: 'Update' } });
    expect(res.statusCode).toBe(200);
  });

  it('POST /api/ai/generate-ticket returns ticket', async () => {
    mockAiService.generateTicketFromDiff.mockResolvedValueOnce({ title: 'Fix bug', description: 'desc', labels: [] });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/ai/generate-ticket', payload: { diff: 'diff content' } });
    expect(res.statusCode).toBe(200);
  });

  it('POST /api/ai/jsx-preview returns JSX', async () => {
    mockAiService.generateJSXPreview.mockResolvedValueOnce('<div>Hello</div>');
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/ai/jsx-preview', payload: { prompt: 'A button' } });
    expect(res.statusCode).toBe(200);
  });

  it('POST /api/ai/jsx-preview/refine returns refined JSX', async () => {
    mockAiService.refineJSXPreview.mockResolvedValueOnce('<div>Updated</div>');
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/ai/jsx-preview/refine', payload: { currentJSX: '<div/>', prompt: 'Make it blue' } });
    expect(res.statusCode).toBe(200);
  });

  it('POST /api/ai/seed-next-stage returns next stage content', async () => {
    mockAiService.seedNextStage.mockResolvedValueOnce('# Next Stage');
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/ai/seed-next-stage', payload: { content: '# Current', fromStage: 'definition', toStage: 'design' } });
    expect(res.statusCode).toBe(200);
  });

  it('POST /api/ai/seed-from-stage returns seeded content', async () => {
    mockAiService.seedNextStage.mockResolvedValueOnce({ title: 'PRD', content: '# PRD Content' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/seed-from-stage',
      payload: { documentId: 'doc-1', fromStage: 'conception', toStage: 'definition', content: '# Concept' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).title).toBe('PRD');
  });

  it('POST /api/ai/seed-from-stage returns 400 when content missing', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/seed-from-stage',
      payload: { documentId: 'doc-1', fromStage: 'conception', toStage: 'definition' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/ai/missing-sections returns missing sections', async () => {
    mockAiService.analyzeMissingSections.mockResolvedValueOnce({
      missingSections: [{ name: 'Security', description: 'No security section', priority: 'high' }],
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/missing-sections',
      payload: { content: '# My Spec', stage: 'definition' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).missingSections).toHaveLength(1);
  });

  it('POST /api/ai/missing-sections returns 400 without content', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/missing-sections',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/ai/notification-reply returns AI reply', async () => {
    mockAiService.notificationReply.mockResolvedValueOnce({
      reply: 'Here is my follow-up',
      suggestedActions: ['Add more detail'],
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/notification-reply',
      payload: { notificationId: 'notif-1', message: 'What should I improve?', documentId: 'doc-1' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).reply).toBe('Here is my follow-up');
  });

  it('POST /api/ai/notification-reply returns 400 without required fields', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/notification-reply',
      payload: { notificationId: 'notif-1' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/ai/generate-all returns 400 without teamId', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/generate-all',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('teamId is required');
  });

  it('POST /api/ai/generate-all returns empty results when no documents', async () => {
    // Mock db to return empty array
    const chain = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      then: (resolve: (v: unknown) => void) => Promise.resolve([]).then(resolve),
    };
    mockDb.select.mockReturnValueOnce(chain as any);
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/generate-all',
      payload: { teamId: 'team-1' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.total).toBe(0);
    expect(body.results).toEqual([]);
  });

  it('POST /api/ai/generate-all generates content for all documents', async () => {
    const mockDocs = [
      { id: 'doc-1', title: 'Feature Spec', content: '', status: 'draft', teamId: 'team-1' },
      { id: 'doc-2', title: 'API Design', content: '', status: 'published', teamId: 'team-1' },
    ];

    // Mock db.select for fetching documents
    const selectChain = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      then: (resolve: (v: unknown) => void) => Promise.resolve(mockDocs).then(resolve),
    };
    mockDb.select.mockReturnValueOnce(selectChain as any);

    // Mock db.update for each document update
    const updateChain = {
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      then: (resolve: (v: unknown) => void) => Promise.resolve([]).then(resolve),
    };
    mockDb.update.mockReturnValue(updateChain as any);

    mockAiService.generateDocument
      .mockResolvedValueOnce({ title: 'Feature Spec', content: '# Feature Spec\nGenerated content' })
      .mockResolvedValueOnce({ title: 'API Design', content: '# API Design\nGenerated content' });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/generate-all',
      payload: { teamId: 'team-1' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.total).toBe(2);
    expect(body.succeeded).toBe(2);
    expect(body.failed).toBe(0);
    expect(body.results).toHaveLength(2);
    expect(body.results[0].status).toBe('success');
    expect(body.results[1].status).toBe('success');
    expect(mockAiService.generateDocument).toHaveBeenCalledTimes(2);
  });

  it('POST /api/ai/generate-all handles partial failures gracefully', async () => {
    const mockDocs = [
      { id: 'doc-1', title: 'Good Doc', content: '', status: 'draft', teamId: 'team-1' },
      { id: 'doc-2', title: 'Bad Doc', content: '', status: 'draft', teamId: 'team-1' },
    ];

    const selectChain = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      then: (resolve: (v: unknown) => void) => Promise.resolve(mockDocs).then(resolve),
    };
    mockDb.select.mockReturnValueOnce(selectChain as any);

    const updateChain = {
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      then: (resolve: (v: unknown) => void) => Promise.resolve([]).then(resolve),
    };
    mockDb.update.mockReturnValue(updateChain as any);

    mockAiService.generateDocument
      .mockResolvedValueOnce({ title: 'Good Doc', content: '# Good\nContent' })
      .mockRejectedValueOnce(new Error('AI provider error'));

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/generate-all',
      payload: { teamId: 'team-1' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.total).toBe(2);
    expect(body.succeeded).toBe(1);
    expect(body.failed).toBe(1);
    expect(body.results[0].status).toBe('success');
    expect(body.results[1].status).toBe('error');
    expect(body.results[1].error).toBe('AI provider error');
  });

  it('POST /api/ai/generate-all skips archived documents', async () => {
    const mockDocs = [
      { id: 'doc-1', title: 'Active Doc', content: '', status: 'draft', teamId: 'team-1' },
      { id: 'doc-2', title: 'Archived Doc', content: '', status: 'archived', teamId: 'team-1' },
    ];

    const selectChain = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      then: (resolve: (v: unknown) => void) => Promise.resolve(mockDocs).then(resolve),
    };
    mockDb.select.mockReturnValueOnce(selectChain as any);

    const updateChain = {
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      then: (resolve: (v: unknown) => void) => Promise.resolve([]).then(resolve),
    };
    mockDb.update.mockReturnValue(updateChain as any);

    mockAiService.generateDocument
      .mockResolvedValueOnce({ title: 'Active Doc', content: '# Active\nContent' });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/generate-all',
      payload: { teamId: 'team-1' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.total).toBe(1);
    expect(body.succeeded).toBe(1);
    expect(mockAiService.generateDocument).toHaveBeenCalledTimes(1);
  });
});
