import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockAiService, mockTicketService, mockGithubService } = vi.hoisted(() => ({
  mockAiService: {
    generateTicketFromDiff: vi.fn(),
    generateBulkTicketSuggestions: vi.fn(),
  },
  mockTicketService: {
    createFromDocument: vi.fn(),
  },
  mockGithubService: {
    getFileTree: vi.fn(),
  },
}));

vi.mock('../../services/ai.service.js', () => ({
  aiService: mockAiService,
}));

vi.mock('../../services/ticket.service.js', () => ({
  ticketService: mockTicketService,
}));

vi.mock('../../services/github.service.js', () => ({
  githubService: mockGithubService,
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
        undefined,
      );
    });

    it('forwards repo param to ticketService.createFromDocument', async () => {
      const suggestion = {
        id: 'sug-2',
        documentId: 'doc-1',
        title: 'Fix bug',
        description: 'There is a bug',
        labels: ['bug'],
        status: 'pending',
      };

      const ticket = { id: 'ticket-2', title: 'Fix bug', externalId: '99' };
      const updated = { ...suggestion, status: 'approved', reviewedById: 'user-1' };

      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([suggestion]),
        }),
      } as any);

      mockTicketService.createFromDocument.mockResolvedValue(ticket);

      mockDb.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updated]),
          }),
        }),
      } as any);

      await suggestionService.approve('sug-2', 'user-1', 'github', { owner: 'myorg', name: 'myrepo' });

      expect(mockTicketService.createFromDocument).toHaveBeenCalledWith(
        'doc-1',
        'github',
        'Fix bug',
        'There is a bug',
        'user-1',
        { owner: 'myorg', name: 'myrepo' },
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

  describe('generateFolderSuggestions', () => {
    it('fetches docs in folder, calls AI, and inserts suggestions', async () => {
      const doc1 = makeDocument({ id: 'doc-1', path: '/specs', content: 'Spec A content', title: 'Spec A', stage: 'definition', teamId: 'team-1', status: 'draft' });
      const doc2 = makeDocument({ id: 'doc-2', path: '/specs', content: 'Spec B content', title: 'Spec B', stage: 'architecture', teamId: 'team-1', status: 'draft' });

      const aiResults = [
        { title: '[M] Review API contracts', description: 'Review all API contracts', labels: ['spec-review'] },
        { title: '[S] Add tests', description: 'Add unit tests', labels: ['enhancement'] },
      ];

      const createdSuggestions = aiResults.map((item, i) => ({
        id: `sug-${i + 1}`,
        documentId: 'doc-1',
        title: item.title,
        description: item.description,
        labels: item.labels,
        status: 'pending',
      }));

      // Select documents in folder
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([doc1, doc2]),
        }),
      } as any);

      mockAiService.generateBulkTicketSuggestions.mockResolvedValue(aiResults);

      // Insert suggestions
      mockDb.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue(createdSuggestions),
        }),
      } as any);

      const result = await suggestionService.generateFolderSuggestions('team-1', '/specs');
      expect(result).toHaveLength(2);
      expect(result[0].title).toBe('[M] Review API contracts');
      expect(mockAiService.generateBulkTicketSuggestions).toHaveBeenCalledWith(
        expect.stringContaining('Spec A'),
        expect.stringContaining('Folder: specs'),
        null,
      );
    });

    it('throws when no documents found in folder', async () => {
      // Select returns no matching docs
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as any);

      await expect(
        suggestionService.generateFolderSuggestions('team-1', '/empty-folder'),
      ).rejects.toThrow('No documents found in this folder');
    });

    it('filters docs to only those in the specified folder path', async () => {
      const docInFolder = makeDocument({ id: 'doc-1', path: '/specs', content: 'In folder', title: 'In', teamId: 'team-1', status: 'draft' });
      const docInSubfolder = makeDocument({ id: 'doc-2', path: '/specs/api', content: 'In subfolder', title: 'Sub', teamId: 'team-1', status: 'draft' });
      const docOutside = makeDocument({ id: 'doc-3', path: '/other', content: 'Outside', title: 'Out', teamId: 'team-1', status: 'draft' });

      // Select returns all draft docs for the team
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([docInFolder, docInSubfolder, docOutside]),
        }),
      } as any);

      const aiResults = [
        { title: '[M] Fix something', description: 'Fix', labels: ['bug'] },
      ];
      mockAiService.generateBulkTicketSuggestions.mockResolvedValue(aiResults);

      mockDb.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'sug-1', ...aiResults[0], status: 'pending', documentId: 'doc-1' }]),
        }),
      } as any);

      await suggestionService.generateFolderSuggestions('team-1', '/specs');

      // AI should receive content from docs in /specs and /specs/api, but NOT /other
      const aiCall = mockAiService.generateBulkTicketSuggestions.mock.calls[0][0];
      expect(aiCall).toContain('In folder');
      expect(aiCall).toContain('In subfolder');
      expect(aiCall).not.toContain('Outside');
    });
  });
});
