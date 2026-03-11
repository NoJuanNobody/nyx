import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the providers before importing the service
vi.mock('../search/providers/brave.provider.js', () => ({
  searchWithBrave: vi.fn(),
}));
vi.mock('../search/providers/tavily.provider.js', () => ({
  searchWithTavily: vi.fn(),
}));

describe('SearchService', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns results from primary provider', async () => {
    const { searchWithBrave } = await import('../search/providers/brave.provider.js');
    (searchWithBrave as ReturnType<typeof vi.fn>).mockResolvedValue([
      { title: 'Test', url: 'https://example.com', snippet: 'test snippet', source: 'brave' },
    ]);

    const { performWebSearch } = await import('../search/search.service.js');
    const result = await performWebSearch('test', 'general', 5);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].title).toBe('Test');
  });

  it('falls back to secondary provider on primary failure', async () => {
    const { searchWithBrave } = await import('../search/providers/brave.provider.js');
    const { searchWithTavily } = await import('../search/providers/tavily.provider.js');

    (searchWithBrave as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Brave failed'));
    (searchWithTavily as ReturnType<typeof vi.fn>).mockResolvedValue([
      { title: 'Fallback', url: 'https://example.com', snippet: 'fallback', source: 'tavily' },
    ]);

    const { performWebSearch } = await import('../search/search.service.js');
    const result = await performWebSearch('test', 'general', 5);

    expect(result.provider).toContain('fallback');
    expect(result.results).toHaveLength(1);
  });

  it('caps max_results at 10', async () => {
    const { searchWithBrave } = await import('../search/providers/brave.provider.js');
    const manyResults = Array.from({ length: 15 }, (_, i) => ({
      title: `Result ${i}`,
      url: `https://example.com/${i}`,
      snippet: `snippet ${i}`,
      source: 'brave',
    }));
    (searchWithBrave as ReturnType<typeof vi.fn>).mockResolvedValue(manyResults);

    const { performWebSearch } = await import('../search/search.service.js');
    const result = await performWebSearch('test', 'general', 20);

    expect(result.results.length).toBeLessThanOrEqual(10);
  });

  it('throws when both providers fail', async () => {
    const { searchWithBrave } = await import('../search/providers/brave.provider.js');
    const { searchWithTavily } = await import('../search/providers/tavily.provider.js');

    (searchWithBrave as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Brave failed'));
    (searchWithTavily as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Tavily failed'));

    const { performWebSearch } = await import('../search/search.service.js');
    await expect(performWebSearch('test', 'general', 5)).rejects.toThrow('Search failed');
  });
});
