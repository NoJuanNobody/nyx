import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetch for GitHub API
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('feedbackService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe('formatFeedback', () => {
    it('should format raw feedback into structured issue', async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        content: [{
          type: 'text',
          text: JSON.stringify({
            title: 'Improve diff view on mobile',
            body: '## Description\nThe diff view is hard to read on mobile devices.',
            category: 'ux-improvement',
          }),
        }],
      });

      vi.doMock('@anthropic-ai/sdk', () => ({
        default: vi.fn().mockImplementation(() => ({
          messages: { create: mockCreate },
        })),
      }));
      vi.doMock('../../db/index.js', () => ({
        db: {
          select: vi.fn().mockReturnThis(),
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockResolvedValue([{ count: 0 }]),
          insert: vi.fn().mockReturnThis(),
          values: vi.fn().mockReturnThis(),
          returning: vi.fn().mockResolvedValue([{ id: 'test-id' }]),
        },
      }));
      vi.doMock('../../lib/config.js', () => ({
        config: {
          ANTHROPIC_API_KEY: 'test-key',
          GITHUB_FEEDBACK_PAT: 'test-pat',
        },
      }));

      const { feedbackService } = await import('../feedback.service.js');
      const result = await feedbackService.formatFeedback('the diff view is hard to read on mobile');

      expect(result).toEqual({
        title: 'Improve diff view on mobile',
        body: '## Description\nThe diff view is hard to read on mobile devices.',
        category: 'ux-improvement',
      });
    });

    it('should return fallback when AI response is not valid JSON', async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'not json' }],
      });

      vi.doMock('@anthropic-ai/sdk', () => ({
        default: vi.fn().mockImplementation(() => ({
          messages: { create: mockCreate },
        })),
      }));
      vi.doMock('../../db/index.js', () => ({
        db: {
          select: vi.fn().mockReturnThis(),
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockResolvedValue([{ count: 0 }]),
          insert: vi.fn().mockReturnThis(),
          values: vi.fn().mockReturnThis(),
          returning: vi.fn().mockResolvedValue([{ id: 'test-id' }]),
        },
      }));
      vi.doMock('../../lib/config.js', () => ({
        config: {
          ANTHROPIC_API_KEY: 'test-key',
          GITHUB_FEEDBACK_PAT: 'test-pat',
        },
      }));

      const { feedbackService } = await import('../feedback.service.js');
      const result = await feedbackService.formatFeedback('some feedback');

      expect(result.title).toBe('User Feedback');
      expect(result.body).toBe('some feedback');
      expect(result.category).toBe('other');
    });
  });

  describe('submitToGitHub', () => {
    it('should create a GitHub issue with feedback label', async () => {
      vi.doMock('@anthropic-ai/sdk', () => ({
        default: vi.fn().mockImplementation(() => ({
          messages: { create: vi.fn() },
        })),
      }));
      vi.doMock('../../db/index.js', () => ({
        db: {
          select: vi.fn().mockReturnThis(),
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockResolvedValue([{ count: 0 }]),
          insert: vi.fn().mockReturnThis(),
          values: vi.fn().mockReturnThis(),
          returning: vi.fn().mockResolvedValue([{ id: 'test-id' }]),
        },
      }));
      vi.doMock('../../lib/config.js', () => ({
        config: {
          ANTHROPIC_API_KEY: 'test-key',
          GITHUB_FEEDBACK_PAT: 'test-pat',
        },
      }));

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          html_url: 'https://github.com/NoJuanNobody/syncdocs/issues/99',
          number: 99,
        }),
      });

      const { feedbackService } = await import('../feedback.service.js');
      const result = await feedbackService.submitToGitHub(
        'Test Title',
        'Test Body',
        'feature-request',
        'Test User',
        'test@example.com',
      );

      expect(result.issueUrl).toBe('https://github.com/NoJuanNobody/syncdocs/issues/99');
      expect(result.issueNumber).toBe(99);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/NoJuanNobody/syncdocs/issues',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"labels":["feedback","feature-request"]'),
        }),
      );
    });

    it('should throw on GitHub API error', async () => {
      vi.doMock('@anthropic-ai/sdk', () => ({
        default: vi.fn().mockImplementation(() => ({
          messages: { create: vi.fn() },
        })),
      }));
      vi.doMock('../../db/index.js', () => ({
        db: {
          select: vi.fn().mockReturnThis(),
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockResolvedValue([{ count: 0 }]),
          insert: vi.fn().mockReturnThis(),
          values: vi.fn().mockReturnThis(),
          returning: vi.fn().mockResolvedValue([{ id: 'test-id' }]),
        },
      }));
      vi.doMock('../../lib/config.js', () => ({
        config: {
          ANTHROPIC_API_KEY: 'test-key',
          GITHUB_FEEDBACK_PAT: 'test-pat',
        },
      }));

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => 'Forbidden',
      });

      const { feedbackService } = await import('../feedback.service.js');

      await expect(
        feedbackService.submitToGitHub('Title', 'Body', 'bug', 'User', 'user@test.com'),
      ).rejects.toThrow('GitHub API error 403');
    });
  });
});
