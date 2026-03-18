export interface SearchResult {
  title: string;
  snippet: string;
  url: string;
}

interface TavilySearchResponse {
  results: Array<{
    title: string;
    content: string;
    url: string;
  }>;
}

const TAVILY_API_URL = 'https://api.tavily.com/search';

/**
 * Perform a web search using the Tavily API.
 * Falls back to a stub response when TAVILY_API_KEY is not configured.
 */
export async function webSearch(query: string): Promise<SearchResult[]> {
  const apiKey = process.env.TAVILY_API_KEY;

  if (!apiKey) {
    return stubSearch(query);
  }

  const response = await fetch(TAVILY_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: 'basic',
      max_results: 10,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Tavily API error (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as TavilySearchResponse;

  return data.results.map((r) => ({
    title: r.title,
    snippet: r.content,
    url: r.url,
  }));
}

function stubSearch(query: string): SearchResult[] {
  return [
    {
      title: `Stub result for: ${query}`,
      snippet:
        'Web search is not configured. Set the TAVILY_API_KEY environment variable to enable live results.',
      url: 'https://tavily.com',
    },
  ];
}
