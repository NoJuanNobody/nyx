import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { webSearch } from '../search.service.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('search.service', () => {
  const originalEnv = process.env.TAVILY_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.TAVILY_API_KEY = originalEnv;
    } else {
      delete process.env.TAVILY_API_KEY;
    }
  });

  describe('webSearch — stub fallback', () => {
    it('should return stub results when TAVILY_API_KEY is not set', async () => {
      delete process.env.TAVILY_API_KEY;

      const results = await webSearch('test query');

      expect(results).toHaveLength(1);
      expect(results[0].title).toContain('Stub result for: test query');
      expect(results[0].snippet).toContain('TAVILY_API_KEY');
      expect(results[0].url).toBe('https://tavily.com');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('webSearch — Tavily API', () => {
    beforeEach(() => {
      process.env.TAVILY_API_KEY = 'test-key-123';
    });

    it('should call Tavily API and return mapped results', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            {
              title: 'Result One',
              content: 'Snippet for result one',
              url: 'https://example.com/one',
            },
            {
              title: 'Result Two',
              content: 'Snippet for result two',
              url: 'https://example.com/two',
            },
          ],
        }),
      });

      const results = await webSearch('fastify plugins');

      expect(mockFetch).toHaveBeenCalledOnce();
      expect(mockFetch).toHaveBeenCalledWith('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: 'test-key-123',
          query: 'fastify plugins',
          search_depth: 'basic',
          max_results: 10,
        }),
      });

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({
        title: 'Result One',
        snippet: 'Snippet for result one',
        url: 'https://example.com/one',
      });
      expect(results[1]).toEqual({
        title: 'Result Two',
        snippet: 'Snippet for result two',
        url: 'https://example.com/two',
      });
    });

    it('should throw on non-OK response from Tavily', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

      await expect(webSearch('bad key query')).rejects.toThrow(
        'Tavily API error (401): Unauthorized',
      );
    });

    it('should handle empty results from Tavily', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: [] }),
      });

      const results = await webSearch('obscure query');

      expect(results).toEqual([]);
    });
  });
});
