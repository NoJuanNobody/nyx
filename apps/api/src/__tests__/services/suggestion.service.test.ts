import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockAiService, mockTicketService } = vi.hoisted(() => ({
  mockAiService: {
    generateTicketFromDiff: vi.fn(),
  },
  mockTicketService: {
    createFromDocument: vi.fn(),
  },
}));

vi.mock('../../services/ai.service.js', () => ({
  aiService: mockAiService,
}));

vi.mock('../../services/ticket.service.js', () => ({
  ticketService: mockTicketService,
}));

import { mockDb } from '../helpers/setup.js';
import { makeDocument, makeVersion } from '../helpers/factories.js';
import { suggestionService } from '../../services/suggestion.service.js';

describe('Suggestion Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('generateSuggestions', () => {
    it('fetches doc, calls AI, and inserts suggestion', async () => {
      const doc = makeDocument({ id: 'doc-1', content: 'current content' });
      const version1 = makeVersion({ documentId: 'doc-1', version: 2, content: 'v2 content' });
      const version2 = makeVersion({ documentId: 'doc-1', version: 1, content: 'v1 content' });

      const aiResult = {
        title: 'Add error handling',
        description: 'The spec lacks error handling details',
        labels: ['enhancement'],
      };

      const suggestion = {
        id: 'sug-1',
        documentId: 'doc-1',
        title: aiResult.title,
        description: aiResult.description,
        labels: aiResult.labels,
        status: 'pending',
      };

      // Select document
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([doc]),
        }),
      } as any);

      // Select versions
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([version1, version2]),
            }),
          }),
        }),
      } as any);

      mockAiService.generateTicketFromDiff.mockResolvedValue(aiResult);

      // Insert suggestion
      mockDb.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([suggestion]),
        }),
      } as any);

      const result = await suggestionService.generateSuggestions('doc-1');
      expect(result).toEqual(suggestion);
      expect(mockAiService.generateTicketFromDiff).toHaveBeenCalled();
      expect(mockDb.insert).toHaveBeenCalled();
    });

    it('throws when document not found', async () => {
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as any);

      await expect(suggestionService.generateSuggestions('nonexistent')).rejects.toThrow(
        'Document not found',
      );
    });
  });

  describe('listByDocument', () => {
    it('returns suggestions for a document', async () => {
      const suggestion = {
        id: 'sug-1',
        documentId: 'doc-1',
        title: 'Fix bug',
        status: 'pending',
      };

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([suggestion]),
          }),
        }),
      } as any);

      const result = await suggestionService.listByDocument('doc-1');
      expect(result).toEqual([suggestion]);
    });
  });

  describe('approve', () => {
    it('creates ticket and updates suggestion status', async () => {
      const suggestion = {
        id: 'sug-1',
        documentId: 'doc-1',
        title: 'Fix bug',
        description: 'There is a bug',
        labels: ['bug'],
        status: 'pending',
      };

      const ticket = {
        id: 'ticket-1',
        title: 'Fix bug',
        externalId: '42',
      };

      const updated = { ...suggestion, status: 'approved', reviewedById: 'user-1' };

      // Select suggestion
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([suggestion]),
        }),
      } as any);

      mockTicketService.createFromDocument.mockResolvedValue(ticket);

      // Update suggestion
      mockDb.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updated]),
          }),
        }),
      } as any);

      const result = await suggestionService.approve('sug-1', 'user-1', 'github');
      expect(result.suggestion.status).toBe('approved');
      expect(result.ticket).toEqual(ticket);
      expect(mockTicketService.createFromDocument).toHaveBeenCalledWith(
        'doc-1',
        'github',
        'Fix bug',
        'There is a bug',
        'user-1',
      );
    });

    it('throws when suggestion not found', async () => {
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as any);

      await expect(
        suggestionService.approve('nonexistent', 'user-1', 'github'),
      ).rejects.toThrow('Suggestion not found');
    });

    it('throws when suggestion already reviewed', async () => {
      const suggestion = { id: 'sug-1', status: 'approved' };

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([suggestion]),
        }),
      } as any);

      await expect(
        suggestionService.approve('sug-1', 'user-1', 'github'),
      ).rejects.toThrow('Suggestion already reviewed');
    });
  });

  describe('dismiss', () => {
    it('updates suggestion status to dismissed', async () => {
      const suggestion = { id: 'sug-1', status: 'pending', documentId: 'doc-1' };
      const updated = { ...suggestion, status: 'dismissed', reviewedById: 'user-1' };

      // Select suggestion
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([suggestion]),
        }),
      } as any);

      // Update
      mockDb.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updated]),
          }),
        }),
      } as any);

      const result = await suggestionService.dismiss('sug-1', 'user-1');
      expect(result.status).toBe('dismissed');
    });

    it('throws when suggestion not found', async () => {
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as any);

      await expect(suggestionService.dismiss('nonexistent', 'user-1')).rejects.toThrow(
        'Suggestion not found',
      );
    });

    it('throws when suggestion already reviewed', async () => {
      const suggestion = { id: 'sug-1', status: 'dismissed' };

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([suggestion]),
        }),
      } as any);

      await expect(suggestionService.dismiss('sug-1', 'user-1')).rejects.toThrow(
        'Suggestion already reviewed',
      );
    });
  });
});
