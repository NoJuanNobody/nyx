import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDb } from '../helpers/setup.js';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { aiRoutes } from '../../routes/ai.js';

vi.mock('../../db/schema.js', () => ({
  documents: { id: 'id', teamId: 'teamId', status: 'status', title: 'title', content: 'content', stage: 'stage' },
  integrations: { teamId: 'teamId', type: 'type', config: 'config' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => args),
  and: vi.fn((...args: unknown[]) => args),
}));

const mockAiService = vi.hoisted(() => ({
  analyzeSpecQuality: vi.fn(),
  detectDrift: vi.fn(),
  generateDocument: vi.fn(),
  editDocument: vi.fn(),
  generateTicketFromDiff: vi.fn(),
  seedNextStage: vi.fn(),
  analyzeMissingSections: vi.fn(),
  notificationReply: vi.fn(),
  generateNewsArticle: vi.fn(),
  generateSuggestions: vi.fn(),
}));
vi.mock('../../services/ai.service.js', () => ({ aiService: mockAiService }));

const mockCodeEmbeddingService = vi.hoisted(() => ({
  fetchRelevantCodeForDocument: vi.fn(),
}));
vi.mock('../../services/code-embedding.service.js', () => ({
  codeEmbeddingService: mockCodeEmbeddingService,
}));
vi.mock('../../middleware/permissions.js', () => ({ requireRole: () => async () => {} }));

async function buildApp() {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error: Error, _request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400).send({
        error: 'Validation failed',
        details: error.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
      });
      return;
    }
    reply.code(500).send({ error: 'Internal server error' });
  });
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
    const body = JSON.parse(res.body);
    expect(body.content).toBe('# Edited');
    expect(body.grounded).toBe(false);
    // No retrieval should happen when documentId/teamId are absent
    expect(mockCodeEmbeddingService.fetchRelevantCodeForDocument).not.toHaveBeenCalled();
    // Service called with empty codeContents
    expect(mockAiService.editDocument).toHaveBeenCalledWith(
      '# Old',
      'Update',
      undefined,
      [],
    );
  });

  it('POST /api/ai/edit-document grounds in codebase when documentId+teamId provided', async () => {
    const docId = '11111111-1111-1111-1111-111111111111';
    const teamId = '22222222-2222-2222-2222-222222222222';
    mockCodeEmbeddingService.fetchRelevantCodeForDocument.mockResolvedValueOnce({
      chunks: [
        { path: 'src/foo.ts', content: 'export function foo() {}' },
        { path: 'src/bar.ts', content: 'export const BAR = 42;' },
      ],
      sources: ['src/foo.ts', 'src/bar.ts'],
    });
    mockAiService.editDocument.mockResolvedValueOnce('# Edited with code');
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/edit-document',
      payload: {
        content: '# Old',
        instruction: 'Fix these',
        documentId: docId,
        teamId,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.content).toBe('# Edited with code');
    expect(body.grounded).toBe(true);
    expect(body.groundingSources).toEqual(['src/foo.ts', 'src/bar.ts']);
    expect(mockCodeEmbeddingService.fetchRelevantCodeForDocument).toHaveBeenCalledWith(
      docId,
      teamId,
    );
    // Service called with non-empty codeContents — triggers the grounded prompt
    expect(mockAiService.editDocument).toHaveBeenCalledWith(
      '# Old',
      'Fix these',
      undefined,
      [
        { path: 'src/foo.ts', content: 'export function foo() {}' },
        { path: 'src/bar.ts', content: 'export const BAR = 42;' },
      ],
    );
  });

  it('POST /api/ai/edit-document falls back to ungrounded when no code chunks', async () => {
    const docId = '11111111-1111-1111-1111-111111111111';
    const teamId = '22222222-2222-2222-2222-222222222222';
    mockCodeEmbeddingService.fetchRelevantCodeForDocument.mockResolvedValueOnce({
      chunks: [],
      sources: [],
    });
    mockAiService.editDocument.mockResolvedValueOnce('# Edited conservative');
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/edit-document',
      payload: { content: '# Old', instruction: 'Fix these', documentId: docId, teamId },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.grounded).toBe(false);
    expect(body.groundingSources).toBeUndefined();
    expect(mockAiService.editDocument).toHaveBeenCalledWith(
      '# Old',
      'Fix these',
      undefined,
      [],
    );
  });

  it('POST /api/ai/edit-document handles retrieval throwing by falling back to ungrounded', async () => {
    const docId = '11111111-1111-1111-1111-111111111111';
    const teamId = '22222222-2222-2222-2222-222222222222';
    mockCodeEmbeddingService.fetchRelevantCodeForDocument.mockRejectedValueOnce(
      new Error('pgvector exploded'),
    );
    mockAiService.editDocument.mockResolvedValueOnce('# Edited conservative');
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/edit-document',
      payload: { content: '# Old', instruction: 'Fix these', documentId: docId, teamId },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.content).toBe('# Edited conservative');
    expect(body.grounded).toBe(false);
  });

  it('POST /api/ai/edit-document returns 400 when only documentId is provided', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/edit-document',
      payload: {
        content: '# Old',
        instruction: 'Fix',
        documentId: '11111111-1111-1111-1111-111111111111',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/ai/edit-document returns 400 when only teamId is provided', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/edit-document',
      payload: {
        content: '# Old',
        instruction: 'Fix',
        teamId: '22222222-2222-2222-2222-222222222222',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/ai/generate-ticket returns ticket', async () => {
    mockAiService.generateTicketFromDiff.mockResolvedValueOnce({ title: 'Fix bug', description: 'desc', labels: [] });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/ai/generate-ticket', payload: { diff: 'diff content' } });
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

  it('POST /api/ai/generate-news-article returns generated article', async () => {
    mockAiService.generateNewsArticle.mockResolvedValueOnce({
      headline: 'City Goes Wild Over New Pizza Flavor',
      content: '# City Goes Wild Over New Pizza Flavor\n\nNew Yorkers lined up...',
      summary: 'A new pizza flavor has taken the city by storm.',
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/generate-news-article',
      payload: { topic: 'A new pizza flavor taking NYC by storm' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.headline).toBe('City Goes Wild Over New Pizza Flavor');
    expect(body.content).toContain('City Goes Wild');
    expect(body.summary).toBeTruthy();
  });

  it('POST /api/ai/generate-news-article passes context when provided', async () => {
    mockAiService.generateNewsArticle.mockResolvedValueOnce({
      headline: 'Tech Giant Shakes Up Market',
      content: '# Tech Giant Shakes Up Market\n\nIn a stunning move...',
      summary: 'Major tech company announces disruptive product.',
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/generate-news-article',
      payload: { topic: 'Tech company launch', context: 'The company raised $500M in funding' },
    });
    expect(res.statusCode).toBe(200);
    expect(mockAiService.generateNewsArticle).toHaveBeenCalledWith(
      'Tech company launch',
      'The company raised $500M in funding',
    );
  });

  it('POST /api/ai/generate-news-article returns 400 without topic', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/generate-news-article',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('Validation failed');
  });

  it('POST /api/ai/generate-all returns 400 without teamId', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/generate-all',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('Validation failed');
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

  // ── POST /api/ai/suggestions ───────────────────────────────
  describe('POST /api/ai/suggestions', () => {
    const docId = '11111111-1111-1111-1111-111111111111';
    const teamId = '22222222-2222-2222-2222-222222222222';

    function mockDocLookup(doc: Record<string, unknown> | null) {
      const chain = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        then: (resolve: (v: unknown) => void) =>
          Promise.resolve(doc ? [doc] : []).then(resolve),
      };
      mockDb.select.mockReturnValueOnce(chain as any);
    }

    function mockIntegrationLookup(row: Record<string, unknown> | null) {
      const chain = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        then: (resolve: (v: unknown) => void) =>
          Promise.resolve(row ? [row] : []).then(resolve),
      };
      mockDb.select.mockReturnValueOnce(chain as any);
    }

    it('pre-session: returns 3 suggestions when the service produces them', async () => {
      mockDocLookup({
        id: docId,
        title: 'Billing API',
        content: '# Billing API\n\nHandles invoices.',
        stage: 'implementation',
        teamId,
      });
      // No GitHub integration connected
      mockIntegrationLookup(null);

      mockAiService.generateSuggestions.mockResolvedValueOnce([
        'Document webhook retries',
        'Cite billing.service.ts',
        'Add rate-limit handling',
      ]);

      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/ai/suggestions',
        payload: {
          kind: 'pre-session',
          documentId: docId,
          teamId,
          content: 'Draft billing doc',
          stage: 'implementation',
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.suggestions).toHaveLength(3);
      expect(body.suggestions).toContain('Cite billing.service.ts');
    });

    it('pre-session: uses fetchRelevantCodeForDocument when GitHub integration exists', async () => {
      mockDocLookup({
        id: docId,
        title: 'Auth API',
        content: 'preview',
        stage: 'architecture',
        teamId,
      });
      mockIntegrationLookup({
        type: 'github',
        config: {
          selectedRepos: [{ owner: 'acme', name: 'backend', fullName: 'acme/backend' }],
        },
      });
      mockCodeEmbeddingService.fetchRelevantCodeForDocument.mockResolvedValueOnce({
        chunks: [
          { path: 'src/auth.ts', content: '...' },
          { path: 'src/session.ts', content: '...' },
        ],
        sources: ['src/auth.ts', 'src/session.ts'],
      });
      mockAiService.generateSuggestions.mockResolvedValueOnce([
        'Verify session rotation',
        'Add MFA check in auth.ts',
        'Document JWT expiry',
      ]);

      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/ai/suggestions',
        payload: { kind: 'pre-session', documentId: docId, teamId },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.suggestions).toHaveLength(3);
      // Verify the service received a codebase hint with the repo and chunks
      const call = mockAiService.generateSuggestions.mock.calls[0][0];
      expect(call.kind).toBe('pre-session');
      expect(call.codebaseHint).toBeDefined();
      expect(call.codebaseHint.repoFullName).toBe('acme/backend');
      expect(call.codebaseHint.chunks).toHaveLength(2);
    });

    it('returns 200 with { suggestions: [] } on service failure', async () => {
      mockDocLookup({
        id: docId,
        title: 'Billing API',
        content: 'preview',
        stage: null,
        teamId,
      });
      mockIntegrationLookup(null);
      mockAiService.generateSuggestions.mockRejectedValueOnce(new Error('anthropic exploded'));

      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/ai/suggestions',
        payload: { kind: 'pre-session', documentId: docId, teamId },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ suggestions: [] });
    });

    it('returns 200 with [] when service returns malformed (fewer than 3) suggestions', async () => {
      mockDocLookup({
        id: docId,
        title: 'Billing API',
        content: 'preview',
        stage: null,
        teamId,
      });
      mockIntegrationLookup(null);
      mockAiService.generateSuggestions.mockResolvedValueOnce(['only one']);

      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/ai/suggestions',
        payload: { kind: 'pre-session', documentId: docId, teamId },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ suggestions: [] });
    });

    it('post-session: returns 3 suggestions and passes history/toolCallSummary/incomplete', async () => {
      mockDocLookup({
        id: docId,
        title: 'Intake Flow',
        content: 'intake doc',
        stage: 'execution',
        teamId,
      });
      mockAiService.generateSuggestions.mockResolvedValueOnce([
        'Deep-dive on file upload limits',
        'Narrow to API routes',
        'Split this into two tasks',
      ]);

      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/ai/suggestions',
        payload: {
          kind: 'post-session',
          documentId: docId,
          teamId,
          history: [{ role: 'user', content: 'Scan codebase for intake, file uploads, audio' }],
          toolCallSummary: [
            { name: 'search_code', count: 3 },
            { name: 'get_github_files', count: 2 },
          ],
          finalResult: 'I found intake.ts and upload.ts',
          incomplete: true,
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.suggestions).toHaveLength(3);

      const call = mockAiService.generateSuggestions.mock.calls[0][0];
      expect(call.kind).toBe('post-session');
      expect(call.history).toHaveLength(1);
      expect(call.toolCallSummary).toHaveLength(2);
      expect(call.incomplete).toBe(true);
      expect(call.finalResult).toContain('intake.ts');
    });

    it('returns 400 when required fields are missing', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/ai/suggestions',
        payload: { kind: 'pre-session' }, // missing documentId + teamId
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns { suggestions: [] } when document is not found', async () => {
      mockDocLookup(null);

      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/ai/suggestions',
        payload: { kind: 'pre-session', documentId: docId, teamId },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ suggestions: [] });
      expect(mockAiService.generateSuggestions).not.toHaveBeenCalled();
    });
  });
});
