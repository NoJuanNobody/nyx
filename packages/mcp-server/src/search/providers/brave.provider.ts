import type { SearchInput, SearchResult } from '../search.types.js';

const BRAVE_API_URL = 'https://api.search.brave.com/res/v1/web/search';

function buildQuery(input: SearchInput): string {
  const { query, searchType } = input;
  switch (searchType) {
    case 'api_reference':
      return `${query} API reference documentation`;
    case 'changelog':
      return `${query} changelog release notes`;
    case 'documentation':
      return `${query} official documentation guide`;
    default:
      return query;
  }
}

export async function searchWithBrave(input: SearchInput): Promise<SearchResult[]> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    throw new Error('BRAVE_SEARCH_API_KEY environment variable is not set');
  }

  const searchQuery = buildQuery(input);
  const params = new URLSearchParams({
    q: searchQuery,
    count: String(input.maxResults),
  });

  const res = await fetch(`${BRAVE_API_URL}?${params}`, {
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': apiKey,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Brave Search API error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as {
    web?: {
      results?: Array<{
        title: string;
        url: string;
        description: string;
      }>;
    };
  };

  return (data.web?.results ?? []).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.description,
    source: 'brave',
  }));
}
