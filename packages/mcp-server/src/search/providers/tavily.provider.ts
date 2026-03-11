import type { SearchInput, SearchResult } from '../search.types.js';

const TAVILY_API_URL = 'https://api.tavily.com/search';

export async function searchWithTavily(input: SearchInput): Promise<SearchResult[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error('TAVILY_API_KEY environment variable is not set');
  }

  const res = await fetch(TAVILY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      api_key: apiKey,
      query: input.query,
      max_results: input.maxResults,
      search_depth: 'basic',
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Tavily API error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as {
    results?: Array<{
      title: string;
      url: string;
      content: string;
    }>;
  };

  return (data.results ?? []).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.content,
    source: 'tavily',
  }));
}
