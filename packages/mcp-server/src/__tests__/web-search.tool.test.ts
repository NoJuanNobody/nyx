import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../search/search.service.js', () => ({
  performWebSearch: vi.fn(),
}));

// Mock apiRequest for existing tools
vi.mock('../auth.js', () => ({
  apiRequest: vi.fn().mockResolvedValue([]),
}));

describe('webSearchTool handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns results in correct shape', async () => {
    const { performWebSearch } = await import('../search/search.service.js');
    (performWebSearch as ReturnType<typeof vi.fn>).mockResolvedValue({
      query: 'test',
      results: [
        { title: 'Result', url: 'https://example.com', snippet: 'snippet', source: 'brave' },
      ],
      provider: 'brave',
      timestamp: '2025-01-01T00:00:00Z',
    });

    const { executeTool } = await import('../tools.js');
    const result = await executeTool('nyx_web_search', { query: 'test' });

    expect(result).toHaveProperty('results');
    expect((result as { results: unknown[] }).results).toHaveLength(1);
  });

  it('handles search errors', async () => {
    const { performWebSearch } = await import('../search/search.service.js');
    (performWebSearch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Search failed'));

    const { executeTool } = await import('../tools.js');
    await expect(executeTool('nyx_web_search', { query: 'test' })).rejects.toThrow(
      'Search failed',
    );
  });
});
