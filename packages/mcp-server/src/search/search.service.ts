import type { SearchInput, SearchResponse, SearchResult } from './search.types.js';
import { searchWithBrave } from './providers/brave.provider.js';
import { searchWithTavily } from './providers/tavily.provider.js';

const PROVIDER = process.env.SYNCDOCS_SEARCH_PROVIDER ?? 'brave';

export async function performWebSearch(
  query: string,
  searchType: string,
  maxResults: number,
): Promise<SearchResponse> {
  const input: SearchInput = {
    query,
    searchType: searchType as SearchInput['searchType'],
    maxResults: Math.min(maxResults, 10),
  };

  let results: SearchResult[];
  let provider: string;

  try {
    if (PROVIDER === 'tavily') {
      results = await searchWithTavily(input);
      provider = 'tavily';
    } else {
      results = await searchWithBrave(input);
      provider = 'brave';
    }
  } catch (primaryError) {
    // Fallback to the other provider
    try {
      if (PROVIDER === 'tavily') {
        results = await searchWithBrave(input);
        provider = 'brave (fallback)';
      } else {
        results = await searchWithTavily(input);
        provider = 'tavily (fallback)';
      }
    } catch (fallbackError) {
      throw new Error(
        `Search failed: primary (${PROVIDER}): ${primaryError instanceof Error ? primaryError.message : String(primaryError)}, fallback: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
      );
    }
  }

  return {
    query,
    results: results.slice(0, input.maxResults),
    provider,
    timestamp: new Date().toISOString(),
  };
}
