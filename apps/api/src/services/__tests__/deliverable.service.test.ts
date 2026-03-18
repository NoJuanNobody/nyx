import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDb, mockExportService, chainable } = vi.hoisted(() => {
  function chainable(resolvedValue: unknown = []) {
    const chain: Record<string, unknown> = {};
    const methods = [
      'select', 'from', 'where', 'insert', 'values', 'returning',
      'update', 'set', 'delete', 'innerJoin', 'orderBy', 'limit',
      'leftJoin', 'groupBy', 'having', 'offset',
    ];
    for (const method of methods) {
      chain[method] = vi.fn(() => chain);
    }
    chain.then = (resolve: (v: unknown) => void) => Promise.resolve(resolvedValue).then(resolve);
    return chain;
  }

  return {
    mockDb: {
      select: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    mockExportService: {
      toMarkdown: vi.fn(),
      toPdf: vi.fn(),
    },
    chainable,
  };
});

vi.mock('../../db/index.js', () => ({
  db: mockDb,
}));

vi.mock('../../lib/config.js', () => ({
  config: {
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  },
}));

vi.mock('../export.service.js', () => ({
  exportService: mockExportService,
}));

import { deliverableService } from '../deliverable.service.js';

describe('deliverableService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('generateDeliverable', () => {
    it('generates a markdown deliverable', async () => {
      const doc = { id: 'doc-1', title: 'Test Doc', content: '# Hello', status: 'draft' };
      const insertedDeliverable = {
        id: 'del-1',
        documentId: 'doc-1',
        stage: 'definition',
        type: 'markdown',
        fileName: 'Test_Doc_definition.md',
        fileUrl: '/deliverables/doc-1/Test_Doc_definition.md',
        generatedAt: new Date().toISOString(),
        metadata: { title: 'Test Doc', status: 'draft' },
      };

      // Mock select for document lookup
      mockDb.select.mockReturnValue(chainable([doc]));
      // Mock insert for deliverable creation
      mockDb.insert.mockReturnValue(chainable([insertedDeliverable]));
      mockExportService.toMarkdown.mockResolvedValue({ title: 'Test Doc', content: '# Hello' });

      const result = await deliverableService.generateDeliverable({
        documentId: 'doc-1',
        stage: 'definition',
        type: 'markdown',
      });

      expect(result).toEqual(insertedDeliverable);
      expect(mockExportService.toMarkdown).toHaveBeenCalledWith('doc-1');
    });

    it('generates a pdf deliverable', async () => {
      const doc = { id: 'doc-1', title: 'Test Doc', content: '# Hello', status: 'draft' };
      const insertedDeliverable = {
        id: 'del-2',
        documentId: 'doc-1',
        stage: 'architecture',
        type: 'pdf',
        fileName: 'Test_Doc_architecture.pdf',
        fileUrl: '/deliverables/doc-1/Test_Doc_architecture.pdf',
      };

      mockDb.select.mockReturnValue(chainable([doc]));
      mockDb.insert.mockReturnValue(chainable([insertedDeliverable]));
      mockExportService.toPdf.mockResolvedValue({ title: 'Test Doc', buffer: Buffer.from('pdf') });

      const result = await deliverableService.generateDeliverable({
        documentId: 'doc-1',
        stage: 'architecture',
        type: 'pdf',
      });

      expect(result).toEqual(insertedDeliverable);
      expect(mockExportService.toPdf).toHaveBeenCalledWith('doc-1');
    });

    it('generates a report deliverable', async () => {
      const doc = { id: 'doc-1', title: 'My Report', content: 'content', status: 'published' };
      const insertedDeliverable = {
        id: 'del-3',
        documentId: 'doc-1',
        stage: 'execution',
        type: 'report',
        fileName: 'My_Report_execution_report.md',
        fileUrl: '/deliverables/doc-1/My_Report_execution_report.md',
      };

      mockDb.select.mockReturnValue(chainable([doc]));
      mockDb.insert.mockReturnValue(chainable([insertedDeliverable]));

      const result = await deliverableService.generateDeliverable({
        documentId: 'doc-1',
        stage: 'execution',
        type: 'report',
      });

      expect(result).toEqual(insertedDeliverable);
    });

    it('returns null when document not found', async () => {
      mockDb.select.mockReturnValue(chainable([]));

      const result = await deliverableService.generateDeliverable({
        documentId: 'nonexistent',
        stage: 'definition',
        type: 'markdown',
      });

      expect(result).toBeNull();
    });

    it('returns null when pdf export fails', async () => {
      const doc = { id: 'doc-1', title: 'Test', content: '', status: 'draft' };
      mockDb.select.mockReturnValue(chainable([doc]));
      mockExportService.toPdf.mockResolvedValue(null);

      const result = await deliverableService.generateDeliverable({
        documentId: 'doc-1',
        stage: 'definition',
        type: 'pdf',
      });

      expect(result).toBeNull();
    });

    it('returns null when markdown export fails', async () => {
      const doc = { id: 'doc-1', title: 'Test', content: '', status: 'draft' };
      mockDb.select.mockReturnValue(chainable([doc]));
      mockExportService.toMarkdown.mockResolvedValue(null);

      const result = await deliverableService.generateDeliverable({
        documentId: 'doc-1',
        stage: 'definition',
        type: 'markdown',
      });

      expect(result).toBeNull();
    });
  });

  describe('listDeliverables', () => {
    it('returns deliverables for a document', async () => {
      const deliverables = [
        { id: 'del-1', documentId: 'doc-1', stage: 'definition', type: 'markdown' },
      ];
      mockDb.select.mockReturnValue(chainable(deliverables));

      const result = await deliverableService.listDeliverables('doc-1');
      expect(result).toEqual(deliverables);
    });

    it('returns empty array when no deliverables exist', async () => {
      mockDb.select.mockReturnValue(chainable([]));

      const result = await deliverableService.listDeliverables('doc-1');
      expect(result).toEqual([]);
    });
  });

  describe('getDeliverable', () => {
    it('returns a deliverable by id', async () => {
      const deliverable = { id: 'del-1', documentId: 'doc-1', type: 'pdf' };
      mockDb.select.mockReturnValue(chainable([deliverable]));

      const result = await deliverableService.getDeliverable('del-1');
      expect(result).toEqual(deliverable);
    });

    it('returns null when not found', async () => {
      mockDb.select.mockReturnValue(chainable([]));

      const result = await deliverableService.getDeliverable('nonexistent');
      expect(result).toBeNull();
    });
  });
});
