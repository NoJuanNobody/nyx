import { describe, it, expect, vi, beforeEach } from 'vitest';
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

import { codeEmbeddingService } from '../../services/code-embedding.service.js';

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
