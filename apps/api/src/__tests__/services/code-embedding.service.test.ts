import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockDb } from '../helpers/setup.js';

// Mock drizzle-orm operators
vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => args),
  and: vi.fn((...args: unknown[]) => args),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));

vi.mock('../../db/schema.js', () => ({
  codeChunks: { teamId: 'teamId' },
  integrations: { teamId: 'teamId', type: 'type' },
  documents: { id: 'id', teamId: 'teamId' },
}));

// Mock the embedding service so we can control return values
const mockGenerateEmbeddings = vi.hoisted(() => vi.fn());
vi.mock('../../services/embedding.service.js', () => ({
  embeddingService: {
    generateEmbeddings: mockGenerateEmbeddings,
  },
}));

// GitHub service shouldn't be called in these helper tests, but stub anyway
vi.mock('../../services/github.service.js', () => ({
  githubService: {
    getFileTree: vi.fn(),
    getFileContent: vi.fn(),
  },
}));

// Chunking mock — not exercised by the helper either
vi.mock('../../services/chunking.service.js', () => ({
  chunkText: vi.fn(() => []),
}));

import { codeEmbeddingService, cacheMetrics, invalidateRelevantCodeCache } from '../../services/code-embedding.service.js';

function mockDocumentLookup(doc: unknown) {
  // Build a chain whose final .limit() resolves to the doc array
  const chain: Record<string, unknown> = {};
  const methods = ['select', 'from', 'where', 'limit'];
  for (const m of methods) chain[m] = vi.fn(() => chain);
  chain.then = (resolve: (v: unknown) => void) => Promise.resolve(doc).then(resolve);
  mockDb.select.mockReturnValueOnce(chain as never);
  return chain;
}

describe('codeEmbeddingService.fetchRelevantCodeForDocument', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Ensure no stale cache entries bleed between tests
    invalidateRelevantCodeCache('22222222-2222-2222-2222-222222222222');
  });

  it('returns empty when the document does not exist', async () => {
    mockDocumentLookup([]);
    const result = await codeEmbeddingService.fetchRelevantCodeForDocument(
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
    );
    expect(result).toEqual({ chunks: [], sources: [] });
    // Should short-circuit before ever calling the embedding service
    expect(mockGenerateEmbeddings).not.toHaveBeenCalled();
  });

  it('returns empty when the team has no indexed code chunks', async () => {
    mockDocumentLookup([
      {
        id: '11111111-1111-1111-1111-111111111111',
        title: 'My Spec',
        content: 'Some content',
        teamId: '22222222-2222-2222-2222-222222222222',
      },
    ]);
    mockGenerateEmbeddings.mockResolvedValueOnce([[0.1, 0.2, 0.3]]);
    // db.execute returns empty array (no chunks match)
    mockDb.execute.mockResolvedValueOnce([]);

    const result = await codeEmbeddingService.fetchRelevantCodeForDocument(
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
    );
    expect(result).toEqual({ chunks: [], sources: [] });
  });

  it('returns empty on retrieval error (pgvector throws)', async () => {
    mockDocumentLookup([
      {
        id: '11111111-1111-1111-1111-111111111111',
        title: 'My Spec',
        content: 'Some content',
        teamId: '22222222-2222-2222-2222-222222222222',
      },
    ]);
    mockGenerateEmbeddings.mockResolvedValueOnce([[0.1, 0.2, 0.3]]);
    mockDb.execute.mockRejectedValueOnce(new Error('pgvector extension missing'));

    const result = await codeEmbeddingService.fetchRelevantCodeForDocument(
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
    );
    expect(result).toEqual({ chunks: [], sources: [] });
  });

  it('returns chunks and de-duped sources when retrieval succeeds', async () => {
    mockDocumentLookup([
      {
        id: '11111111-1111-1111-1111-111111111111',
        title: 'My Spec',
        content: 'Some content',
        teamId: '22222222-2222-2222-2222-222222222222',
      },
    ]);
    mockGenerateEmbeddings.mockResolvedValueOnce([[0.1, 0.2, 0.3]]);
    mockDb.execute.mockResolvedValueOnce([
      { file_path: 'src/foo.ts', content: 'chunk1', score: 0.9, chunk_index: 0 },
      { file_path: 'src/foo.ts', content: 'chunk2', score: 0.8, chunk_index: 1 },
      { file_path: 'src/bar.ts', content: 'chunk3', score: 0.7, chunk_index: 0 },
    ]);

    const result = await codeEmbeddingService.fetchRelevantCodeForDocument(
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
    );
    expect(result.chunks).toHaveLength(3);
    expect(result.chunks[0]).toEqual({ path: 'src/foo.ts', content: 'chunk1' });
    // De-duped sources preserve order
    expect(result.sources).toEqual(['src/foo.ts', 'src/bar.ts']);
  });

  it('returns empty when the embedding service throws', async () => {
    mockDocumentLookup([
      {
        id: '11111111-1111-1111-1111-111111111111',
        title: 'My Spec',
        content: 'Some content',
        teamId: '22222222-2222-2222-2222-222222222222',
      },
    ]);
    mockGenerateEmbeddings.mockRejectedValueOnce(new Error('OpenAI unavailable'));

    const result = await codeEmbeddingService.fetchRelevantCodeForDocument(
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
    );
    expect(result).toEqual({ chunks: [], sources: [] });
  });
});

// ── LRU cache tests ────────────────────────────────────────────────────────

describe('codeEmbeddingService — LRU cache', () => {
  const TEAM_A = 'cache-team-a';
  const TEAM_B = 'cache-team-b';
  const DOC_ID = 'cache-doc-1';

  function mockDocForTeam(teamId: string, docId = DOC_ID) {
    const chain: Record<string, unknown> = {};
    const methods = ['select', 'from', 'where', 'limit'];
    for (const m of methods) chain[m] = vi.fn(() => chain);
    chain.then = (resolve: (v: unknown) => void) =>
      Promise.resolve([
        { id: docId, title: 'Cache Test Doc', content: 'Cache content body', teamId },
      ]).then(resolve);
    mockDb.select.mockReturnValueOnce(chain as never);
    return chain;
  }

  function mockSearchResult() {
    mockGenerateEmbeddings.mockResolvedValueOnce([[0.1, 0.2, 0.3]]);
    mockDb.execute.mockResolvedValueOnce([
      { file_path: 'src/cache.ts', content: 'cached chunk', score: 0.95, chunk_index: 0 },
    ]);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // Clear cache for our test teams
    invalidateRelevantCodeCache(TEAM_A);
    invalidateRelevantCodeCache(TEAM_B);
    cacheMetrics.hits = 0;
    cacheMetrics.misses = 0;
    cacheMetrics.evictions = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    invalidateRelevantCodeCache(TEAM_A);
    invalidateRelevantCodeCache(TEAM_B);
  });

  it('cache hit: second call returns cached result without re-calling embeddingService', async () => {
    // First call — DB + embedding
    mockDocForTeam(TEAM_A);
    mockSearchResult();
    const result1 = await codeEmbeddingService.fetchRelevantCodeForDocument(DOC_ID, TEAM_A);

    // Second call — same doc/team/content: should be a cache hit
    mockDocForTeam(TEAM_A);
    const result2 = await codeEmbeddingService.fetchRelevantCodeForDocument(DOC_ID, TEAM_A);

    expect(result1).toEqual(result2);
    // generateEmbeddings called only once (first call), not on the cache hit
    expect(mockGenerateEmbeddings).toHaveBeenCalledTimes(1);
    expect(cacheMetrics.hits).toBeGreaterThanOrEqual(1);
    expect(cacheMetrics.misses).toBeGreaterThanOrEqual(1);
  });

  it('TTL expiry: expired entry treated as cache miss', async () => {
    // First call — populates cache
    mockDocForTeam(TEAM_A, 'ttl-doc');
    mockSearchResult();
    await codeEmbeddingService.fetchRelevantCodeForDocument('ttl-doc', TEAM_A);

    const missCount = cacheMetrics.misses;
    const embedCallCount = mockGenerateEmbeddings.mock.calls.length;

    // Advance Date.now past 5-min TTL
    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(realNow + 310_000);

    // Second call — expired, should miss and invoke embedding again
    mockDocForTeam(TEAM_A, 'ttl-doc');
    mockSearchResult();
    await codeEmbeddingService.fetchRelevantCodeForDocument('ttl-doc', TEAM_A);

    expect(cacheMetrics.misses).toBe(missCount + 1);
    expect(mockGenerateEmbeddings.mock.calls.length).toBe(embedCallCount + 1);
  });

  it('team invalidation: clears entries for target team, leaves other teams intact', async () => {
    // Populate cache for TEAM_A
    mockDocForTeam(TEAM_A, 'inv-doc-a');
    mockSearchResult();
    await codeEmbeddingService.fetchRelevantCodeForDocument('inv-doc-a', TEAM_A);

    // Populate cache for TEAM_B
    mockDocForTeam(TEAM_B, 'inv-doc-b');
    mockSearchResult();
    await codeEmbeddingService.fetchRelevantCodeForDocument('inv-doc-b', TEAM_B);

    const embedCallsAfterPopulate = mockGenerateEmbeddings.mock.calls.length;

    // Invalidate TEAM_A
    invalidateRelevantCodeCache(TEAM_A);

    vi.clearAllMocks();
    cacheMetrics.hits = 0;
    cacheMetrics.misses = 0;

    // TEAM_A should miss — calls embedding
    mockDocForTeam(TEAM_A, 'inv-doc-a');
    mockSearchResult();
    await codeEmbeddingService.fetchRelevantCodeForDocument('inv-doc-a', TEAM_A);
    expect(mockGenerateEmbeddings).toHaveBeenCalledTimes(1);

    // TEAM_B should hit — no additional embedding call
    mockDocForTeam(TEAM_B, 'inv-doc-b');
    await codeEmbeddingService.fetchRelevantCodeForDocument('inv-doc-b', TEAM_B);
    expect(mockGenerateEmbeddings).toHaveBeenCalledTimes(1); // still 1, not 2
    expect(cacheMetrics.hits).toBeGreaterThanOrEqual(1);

    // Suppress unused variable warning
    void embedCallsAfterPopulate;
  });

  it('LRU eviction: oldest entry evicted when cache exceeds MAX_GLOBAL', async () => {
    const searchSpy = vi.spyOn(codeEmbeddingService, 'searchCode');

    // Fill cache with 1000 unique entries (each unique teamId + docId combination)
    for (let i = 0; i < 1000; i++) {
      const teamId = `lru-team-${i}`;
      const docId = `lru-doc-${i}`;

      const chain: Record<string, unknown> = {};
      const methods = ['select', 'from', 'where', 'limit'];
      for (const m of methods) chain[m] = vi.fn(() => chain);
      chain.then = (resolve: (v: unknown) => void) =>
        Promise.resolve([
          { id: docId, title: `Doc ${i}`, content: `Content ${i}`, teamId },
        ]).then(resolve);
      mockDb.select.mockReturnValueOnce(chain as never);

      searchSpy.mockResolvedValueOnce([
        { filePath: `src/file-${i}.ts`, content: `chunk ${i}`, score: 0.9, chunkIndex: 0 },
      ]);
    }

    cacheMetrics.evictions = 0;

    // Issue 1000 unique fetches to fill cache
    for (let i = 0; i < 1000; i++) {
      await codeEmbeddingService.fetchRelevantCodeForDocument(`lru-doc-${i}`, `lru-team-${i}`);
    }

    // One more — should trigger LRU eviction
    const overflowTeamId = 'lru-team-overflow';
    const overflowDocId = 'lru-doc-overflow';

    const overflowChain: Record<string, unknown> = {};
    const methods = ['select', 'from', 'where', 'limit'];
    for (const m of methods) overflowChain[m] = vi.fn(() => overflowChain);
    overflowChain.then = (resolve: (v: unknown) => void) =>
      Promise.resolve([
        { id: overflowDocId, title: 'Overflow', content: 'Overflow content', teamId: overflowTeamId },
      ]).then(resolve);
    mockDb.select.mockReturnValueOnce(overflowChain as never);
    searchSpy.mockResolvedValueOnce([
      { filePath: 'src/overflow.ts', content: 'overflow chunk', score: 0.85, chunkIndex: 0 },
    ]);

    await codeEmbeddingService.fetchRelevantCodeForDocument(overflowDocId, overflowTeamId);

    expect(cacheMetrics.evictions).toBeGreaterThanOrEqual(1);

    // Cleanup
    for (let i = 0; i < 1000; i++) {
      invalidateRelevantCodeCache(`lru-team-${i}`);
    }
    invalidateRelevantCodeCache(overflowTeamId);
  });

  it('cacheMetrics exports hits, misses, and evictions counters', () => {
    expect(typeof cacheMetrics.hits).toBe('number');
    expect(typeof cacheMetrics.misses).toBe('number');
    expect(typeof cacheMetrics.evictions).toBe('number');
  });
});
