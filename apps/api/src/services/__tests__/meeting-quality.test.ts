import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('aiService — meeting quality', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe('analyzeMeetingNoteQuality', () => {
    it('should return score, suggestions, and meeting metrics', async () => {
      const mockResponse = {
        score: 6,
        suggestions: [
          'Add deadlines to action items',
          'Assign owners to decisions',
        ],
        meetingMetrics: {
          decisions: 3,
          actionItems: 5,
          codeReferences: 2,
          openQuestions: 1,
        },
      };

      const mockCreate = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify(mockResponse) }],
      });

      vi.doMock('@anthropic-ai/sdk', () => ({
        default: vi.fn().mockImplementation(() => ({
          messages: { create: mockCreate },
        })),
      }));
      vi.doMock('../../lib/config.js', () => ({
        config: { ANTHROPIC_API_KEY: 'test-key' },
      }));

      const { aiService } = await import('../ai.service.js');
      const result = await aiService.analyzeMeetingNoteQuality(
        '# Meeting Notes: Sprint Planning\n\n## Decisions\n- Use React for frontend\n\n## Action Items\n- Set up CI pipeline',
      );

      expect(result.score).toBe(6);
      expect(result.suggestions).toHaveLength(2);
      expect(result.suggestions[0]).toBe('Add deadlines to action items');
      expect(result.meetingMetrics.decisions).toBe(3);
      expect(result.meetingMetrics.actionItems).toBe(5);
      expect(result.meetingMetrics.codeReferences).toBe(2);
      expect(result.meetingMetrics.openQuestions).toBe(1);
    });

    it('should handle response wrapped in code fences', async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        content: [
          {
            type: 'text',
            text: '```json\n{"score": 8, "suggestions": ["Looks good"], "meetingMetrics": {"decisions": 2, "actionItems": 3, "codeReferences": 1, "openQuestions": 0}}\n```',
          },
        ],
      });

      vi.doMock('@anthropic-ai/sdk', () => ({
        default: vi.fn().mockImplementation(() => ({
          messages: { create: mockCreate },
        })),
      }));
      vi.doMock('../../lib/config.js', () => ({
        config: { ANTHROPIC_API_KEY: 'test-key' },
      }));

      const { aiService } = await import('../ai.service.js');
      const result = await aiService.analyzeMeetingNoteQuality('# Meeting Notes: Test');

      expect(result.score).toBe(8);
      expect(result.suggestions).toEqual(['Looks good']);
      expect(result.meetingMetrics.decisions).toBe(2);
    });

    it('should return fallback when AI response is not valid JSON', async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'The notes score 7/10 overall.' }],
      });

      vi.doMock('@anthropic-ai/sdk', () => ({
        default: vi.fn().mockImplementation(() => ({
          messages: { create: mockCreate },
        })),
      }));
      vi.doMock('../../lib/config.js', () => ({
        config: { ANTHROPIC_API_KEY: 'test-key' },
      }));

      const { aiService } = await import('../ai.service.js');
      const result = await aiService.analyzeMeetingNoteQuality('# Meeting Notes: Test');

      expect(result.score).toBe(7);
      expect(result.suggestions).toHaveLength(1);
      expect(result.meetingMetrics).toEqual({
        decisions: 0,
        actionItems: 0,
        codeReferences: 0,
        openQuestions: 0,
      });
    });

    it('should default missing meetingMetrics fields to 0', async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              score: 5,
              suggestions: [],
              meetingMetrics: { decisions: 1 },
            }),
          },
        ],
      });

      vi.doMock('@anthropic-ai/sdk', () => ({
        default: vi.fn().mockImplementation(() => ({
          messages: { create: mockCreate },
        })),
      }));
      vi.doMock('../../lib/config.js', () => ({
        config: { ANTHROPIC_API_KEY: 'test-key' },
      }));

      const { aiService } = await import('../ai.service.js');
      const result = await aiService.analyzeMeetingNoteQuality('# Meeting Notes: Test');

      expect(result.meetingMetrics.decisions).toBe(1);
      expect(result.meetingMetrics.actionItems).toBe(0);
      expect(result.meetingMetrics.codeReferences).toBe(0);
      expect(result.meetingMetrics.openQuestions).toBe(0);
    });
  });

  describe('applyMeetingSuggestions', () => {
    it('should return improved content', async () => {
      const improvedContent =
        '# Meeting Notes: Sprint Planning\n\n## Decisions\n- **Decision**: Use React for frontend (Owner: @alice, Date: 2026-03-16)\n\n## Action Items\n- [ ] Set up CI pipeline — @bob — Due: 2026-03-20';

      const mockCreate = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: improvedContent }],
      });

      vi.doMock('@anthropic-ai/sdk', () => ({
        default: vi.fn().mockImplementation(() => ({
          messages: { create: mockCreate },
        })),
      }));
      vi.doMock('../../lib/config.js', () => ({
        config: { ANTHROPIC_API_KEY: 'test-key' },
      }));

      const { aiService } = await import('../ai.service.js');
      const result = await aiService.applyMeetingSuggestions(
        '# Meeting Notes: Sprint Planning\n\n## Decisions\n- Use React\n\n## Action Items\n- Set up CI',
        ['Add owners to decisions', 'Add deadlines to action items'],
      );

      expect(result).toContain('Owner: @alice');
      expect(result).toContain('Due: 2026-03-20');
    });

    it('should strip code fences from response', async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        content: [
          {
            type: 'text',
            text: '```markdown\n# Improved Notes\n\nContent here\n```',
          },
        ],
      });

      vi.doMock('@anthropic-ai/sdk', () => ({
        default: vi.fn().mockImplementation(() => ({
          messages: { create: mockCreate },
        })),
      }));
      vi.doMock('../../lib/config.js', () => ({
        config: { ANTHROPIC_API_KEY: 'test-key' },
      }));

      const { aiService } = await import('../ai.service.js');
      const result = await aiService.applyMeetingSuggestions(
        '# Notes',
        ['Improve structure'],
      );

      expect(result).toBe('# Improved Notes\n\nContent here');
      expect(result).not.toContain('```');
    });

    it('should include all suggestions in the prompt', async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: '# Updated' }],
      });

      vi.doMock('@anthropic-ai/sdk', () => ({
        default: vi.fn().mockImplementation(() => ({
          messages: { create: mockCreate },
        })),
      }));
      vi.doMock('../../lib/config.js', () => ({
        config: { ANTHROPIC_API_KEY: 'test-key' },
      }));

      const { aiService } = await import('../ai.service.js');
      await aiService.applyMeetingSuggestions(
        '# Notes',
        ['Add owners', 'Add deadlines', 'Clarify decisions'],
      );

      const callArgs = mockCreate.mock.calls[0][0];
      const userMessage = callArgs.messages[0].content;
      expect(userMessage).toContain('1. Add owners');
      expect(userMessage).toContain('2. Add deadlines');
      expect(userMessage).toContain('3. Clarify decisions');
    });
  });

  describe('analyzeMeetingNoteQuality — score recalculation', () => {
    it('should allow re-analysis after edits are applied', async () => {
      let callCount = 0;
      const mockCreate = vi.fn().mockImplementation(() => {
        callCount++;
        const score = callCount === 1 ? 5 : 8;
        return Promise.resolve({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                score,
                suggestions: callCount === 1 ? ['Fix items'] : [],
                meetingMetrics: {
                  decisions: 2,
                  actionItems: 3,
                  codeReferences: 1,
                  openQuestions: callCount === 1 ? 2 : 0,
                },
              }),
            },
          ],
        });
      });

      vi.doMock('@anthropic-ai/sdk', () => ({
        default: vi.fn().mockImplementation(() => ({
          messages: { create: mockCreate },
        })),
      }));
      vi.doMock('../../lib/config.js', () => ({
        config: { ANTHROPIC_API_KEY: 'test-key' },
      }));

      const { aiService } = await import('../ai.service.js');

      // First analysis — lower score
      const first = await aiService.analyzeMeetingNoteQuality('# Meeting Notes: v1');
      expect(first.score).toBe(5);
      expect(first.suggestions).toEqual(['Fix items']);

      // After applying suggestions, re-analyze — higher score
      const second = await aiService.analyzeMeetingNoteQuality('# Meeting Notes: v2 (improved)');
      expect(second.score).toBe(8);
      expect(second.suggestions).toEqual([]);
      expect(second.meetingMetrics.openQuestions).toBe(0);
    });
  });
});
