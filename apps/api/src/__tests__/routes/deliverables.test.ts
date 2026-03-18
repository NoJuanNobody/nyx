import { describe, it, expect, vi, beforeEach } from 'vitest';
import '../helpers/setup.js';
import Fastify from 'fastify';

const { mockDeliverableService } = vi.hoisted(() => ({
  mockDeliverableService: {
    generateDeliverable: vi.fn(),
    listDeliverables: vi.fn(),
    getDeliverable: vi.fn(),
  },
}));

vi.mock('../../services/deliverable.service.js', () => ({
  deliverableService: mockDeliverableService,
}));

import { deliverableRoutes, deliverableSingleRoutes } from '../../routes/deliverables.js';

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
  app.register(deliverableRoutes, { prefix: '/api/documents' });
  app.register(deliverableSingleRoutes, { prefix: '/api/deliverables' });
  await app.ready();
  return app;
}

describe('Deliverable Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /api/documents/:id/deliverables', () => {
    it('creates a deliverable and returns 201', async () => {
      const created = {
        id: 'del-1',
        documentId: 'doc-1',
        stage: 'definition',
        type: 'markdown',
        fileName: 'Test_Doc_definition.md',
        fileUrl: '/deliverables/doc-1/Test_Doc_definition.md',
        generatedAt: new Date().toISOString(),
        metadata: { title: 'Test Doc', status: 'draft' },
      };
      mockDeliverableService.generateDeliverable.mockResolvedValue(created);

      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/documents/doc-1/deliverables',
        payload: { stage: 'definition', type: 'markdown' },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.id).toBe('del-1');
      expect(body.type).toBe('markdown');
      expect(mockDeliverableService.generateDeliverable).toHaveBeenCalledWith({
        documentId: 'doc-1',
        stage: 'definition',
        type: 'markdown',
      });
    });

    it('returns 404 when document not found', async () => {
      mockDeliverableService.generateDeliverable.mockResolvedValue(null);

      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/documents/nonexistent/deliverables',
        payload: { stage: 'definition', type: 'pdf' },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Document not found');
    });

    it('returns 400 when stage is missing', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/documents/doc-1/deliverables',
        payload: { type: 'pdf' },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toContain('required');
    });

    it('returns 400 when type is missing', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/documents/doc-1/deliverables',
        payload: { stage: 'definition' },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toContain('required');
    });

    it('returns 400 for invalid type', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/documents/doc-1/deliverables',
        payload: { stage: 'definition', type: 'invalid' },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toContain('type must be one of');
    });
  });

  describe('GET /api/documents/:id/deliverables', () => {
    it('returns deliverables for a document', async () => {
      const deliverables = [
        { id: 'del-1', documentId: 'doc-1', stage: 'definition', type: 'markdown' },
        { id: 'del-2', documentId: 'doc-1', stage: 'architecture', type: 'pdf' },
      ];
      mockDeliverableService.listDeliverables.mockResolvedValue(deliverables);

      const app = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/documents/doc-1/deliverables',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.deliverables).toHaveLength(2);
      expect(mockDeliverableService.listDeliverables).toHaveBeenCalledWith('doc-1');
    });

    it('returns empty array when no deliverables exist', async () => {
      mockDeliverableService.listDeliverables.mockResolvedValue([]);

      const app = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/documents/doc-1/deliverables',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.deliverables).toHaveLength(0);
    });
  });

  describe('GET /api/deliverables/:id', () => {
    it('returns a single deliverable', async () => {
      const deliverable = {
        id: 'del-1',
        documentId: 'doc-1',
        stage: 'definition',
        type: 'report',
        fileName: 'Test_report.md',
        fileUrl: '/deliverables/doc-1/Test_report.md',
      };
      mockDeliverableService.getDeliverable.mockResolvedValue(deliverable);

      const app = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/deliverables/del-1',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.id).toBe('del-1');
      expect(body.type).toBe('report');
    });

    it('returns 404 when deliverable not found', async () => {
      mockDeliverableService.getDeliverable.mockResolvedValue(null);

      const app = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/deliverables/nonexistent',
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Deliverable not found');
    });
  });
});
