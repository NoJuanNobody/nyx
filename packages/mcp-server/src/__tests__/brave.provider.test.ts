import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { searchWithBrave } from '../search/providers/brave.provider.js';

describe('BraveProvider', () => {
  beforeEach(() => {
    vi.stubEnv('BRAVE_SEARCH_API_KEY', 'test-brave-key');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('builds correct query for api_reference type', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ web: { results: [] } }),
    });

    await searchWithBrave({ query: 'react hooks', searchType: 'api_reference', maxResults: 5 });

    const calledUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toContain('react+hooks+API+reference+documentation');
  });

  it('normalizes response to SearchResult format', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          web: {
            results: [
              { title: 'React Docs', url: 'https://react.dev', description: 'Official React docs' },
            ],
          },
        }),
    });

    const results = await searchWithBrave({ query: 'react', searchType: 'general', maxResults: 5 });
    expect(results[0]).toEqual({
      title: 'React Docs',
      url: 'https://react.dev',
      snippet: 'Official React docs',
      source: 'brave',
    });
  });

  it('throws error when API key is missing', async () => {
    vi.stubEnv('BRAVE_SEARCH_API_KEY', '');
    await expect(
      searchWithBrave({ query: 'test', searchType: 'general', maxResults: 5 }),
    ).rejects.toThrow();
  });

  it('propagates API errors', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 429,
      text: () => Promise.resolve('Rate limited'),
    });

    await expect(
      searchWithBrave({ query: 'test', searchType: 'general', maxResults: 5 }),
    ).rejects.toThrow('Brave Search API error 429');
  });
});
