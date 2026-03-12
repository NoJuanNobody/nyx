export interface SearchInput {
  query: string;
  searchType: 'general' | 'api_reference' | 'changelog' | 'documentation';
  maxResults: number;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  provider: string;
  timestamp: string;
}

export interface SearchEvent {
  type: 'search_started' | 'search_completed' | 'search_failed';
  query: string;
  results?: SearchResult[];
  error?: string;
  timestamp: string;
}
