import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { searchWithTavily } from '../search/providers/tavily.provider.js';

describe('TavilyProvider', () => {
  beforeEach(() => {
    vi.stubEnv('TAVILY_API_KEY', 'test-tavily-key');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('sends correct request body', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ results: [] }),
    });

    await searchWithTavily({ query: 'test query', searchType: 'general', maxResults: 3 });

    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.query).toBe('test query');
    expect(body.max_results).toBe(3);
    expect(body.api_key).toBe('test-tavily-key');
  });

  it('normalizes response to SearchResult format', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          results: [{ title: 'Test Page', url: 'https://test.com', content: 'Test content' }],
        }),
    });

    const results = await searchWithTavily({ query: 'test', searchType: 'general', maxResults: 5 });
    expect(results[0]).toEqual({
      title: 'Test Page',
      url: 'https://test.com',
      snippet: 'Test content',
      source: 'tavily',
    });
  });

  it('throws error when API key is missing', async () => {
    vi.stubEnv('TAVILY_API_KEY', '');
    await expect(
      searchWithTavily({ query: 'test', searchType: 'general', maxResults: 5 }),
    ).rejects.toThrow();
  });

  it('propagates API errors', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal error'),
    });

    await expect(
      searchWithTavily({ query: 'test', searchType: 'general', maxResults: 5 }),
    ).rejects.toThrow('Tavily API error 500');
  });
});
