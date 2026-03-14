import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockFetch } from '../helpers/setup.js';

const mockCreate = vi.hoisted(() => vi.fn());
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: mockCreate };
  },
}));

import { generateMockupHTML } from '../../services/mockup.service.js';

describe('Mockup Service', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe('generateMockupHTML', () => {
    it('returns generated HTML from AI', async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: '<div class="mockup">Login Page</div>' }],
      });

      const result = await generateMockupHTML('A login page');
      expect(result).toContain('Login Page');
    });

    it('throws when AI returns no text content', async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 'x', name: 'y', input: {} }],
      });

      await expect(generateMockupHTML('A simple page')).rejects.toThrow('AI did not return text content');
    });
  });
});
