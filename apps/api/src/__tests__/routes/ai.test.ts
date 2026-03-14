import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDb } from '../helpers/setup.js';
import Fastify from 'fastify';
import { aiRoutes } from '../../routes/ai.js';

const mockAiService = vi.hoisted(() => ({
  analyzeSpecQuality: vi.fn(),
  detectDrift: vi.fn(),
  generateDocument: vi.fn(),
  editDocument: vi.fn(),
  generateTicketFromDiff: vi.fn(),
  generateJSXPreview: vi.fn(),
  refineJSXPreview: vi.fn(),
  seedNextStage: vi.fn(),
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
});
