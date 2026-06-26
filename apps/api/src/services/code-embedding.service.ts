/**
 * Code Embedding Pipeline — indexes code from connected GitHub repos
 * into the code_chunks table for RAG-powered codebase search.
 *
 * Flow: fetch file tree → filter relevant files → chunk → embed → store
 */

import { createHash } from 'crypto';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { codeChunks, documents, integrations } from '../db/schema.js';
import { githubService, type GitHubTreeEntry } from './github.service.js';
import { chunkText } from './chunking.service.js';
import { embeddingService } from './embedding.service.js';
import { config } from '../lib/config.js';

// ── Relevant-code retrieval cache ──────────────────────
// In-memory LRU cache keyed by teamId:documentId:contentHash.
// TTL = 5 min; per-team cap = 200; global cap = 1 000.
// Invalidated on every successful indexRepo() run for that team.

interface RelevantCodeCacheEntry {
  result: { chunks: Array<{ path: string; content: string }>; sources: string[] };
  expiresAt: number;
  teamId: string;
}

const CACHE_TTL_MS = 5 * 60 * 1_000;
const MAX_PER_TEAM = 200;
const MAX_GLOBAL = 1_000;

const _relevantCodeCache = new Map<string, RelevantCodeCacheEntry>();
export const cacheMetrics = { hits: 0, misses: 0, evictions: 0 };

function _hashContent(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

function _pruneExpired(): void {
  const now = Date.now();
  for (const [key, entry] of _relevantCodeCache) {
    if (entry.expiresAt < now) {
      _relevantCodeCache.delete(key);
      cacheMetrics.evictions++;
    }
  }
}

function _evictLRU(): void {
  const firstKey = _relevantCodeCache.keys().next().value;
  if (firstKey !== undefined) {
    _relevantCodeCache.delete(firstKey);
    cacheMetrics.evictions++;
  }
}

function _countEntriesForTeam(teamId: string): number {
  let count = 0;
  for (const entry of _relevantCodeCache.values()) {
    if (entry.teamId === teamId) count++;
  }
  return count;
}

export function invalidateRelevantCodeCache(teamId: string): void {
  for (const [key, entry] of _relevantCodeCache) {
    if (entry.teamId === teamId) {
      _relevantCodeCache.delete(key);
    }
  }
}

// ── File filtering ─────────────────────────────────────

const IGNORED_DIRS = new Set([
  'node_modules', 'dist', 'build', '.git', '.next', '.nuxt',
  'coverage', '.cache', '.turbo', '__pycache__', '.venv',
  'vendor', 'target', 'out', '.output',
]);

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java',
  '.rb', '.php', '.swift', '.kt', '.cs', '.cpp', '.c', '.h',
  '.vue', '.svelte', '.astro',
  '.sql', '.graphql', '.gql', '.proto',
  '.yaml', '.yml', '.toml',
  '.md', '.mdx',
  '.sh', '.bash',
]);

export function isIndexableFile(entry: GitHubTreeEntry): boolean {
  if (entry.type !== 'blob') return false;
  const pathParts = entry.path.split('/');
  if (pathParts.some((part) => IGNORED_DIRS.has(part))) return false;
  const ext = '.' + entry.path.split('.').pop()?.toLowerCase();
  return CODE_EXTENSIONS.has(ext);
}

// ── Chunking for code ──────────────────────────────────

/**
 * Chunk code with file path prefix so embeddings carry file context.
 * Uses smaller chunks than docs since code is denser.
 */
function chunkCodeFile(filePath: string, content: string): string[] {
  const prefix = `// File: ${filePath}\n`;
  const rawChunks = chunkText(content, { chunkSize: 1500, overlap: 150 });
  return rawChunks.map((chunk) => `${prefix}${chunk}`);
}

// ── Limits ─────────────────────────────────────────────

const MAX_FILES = 200;
const MAX_FILE_SIZE = 50_000; // 50KB per file
const EMBEDDING_BATCH_SIZE = 50;

// ── Service ────────────────────────────────────────────

export interface CodeIndexResult {
  teamId: string;
  repoFullName: string;
  filesIndexed: number;
  chunksCreated: number;
  skippedFiles: number;
  error?: string;
}

export const codeEmbeddingService = {
  /**
   * Index (or re-index) a team's connected GitHub repo into code_chunks.
   * Deletes existing chunks for the repo before inserting new ones.
   */
  async indexRepo(teamId: string): Promise<CodeIndexResult> {
    // 1. Get GitHub integration
    const [integration] = await db
      .select()
      .from(integrations)
      .where(and(eq(integrations.teamId, teamId), eq(integrations.type, 'github')));

    if (!integration) {
      return { teamId, repoFullName: '', filesIndexed: 0, chunksCreated: 0, skippedFiles: 0, error: 'No GitHub integration configured' };
    }

    const ghConfig = integration.config as {
      accessToken?: string;
      selectedRepos?: Array<{ owner: string; name: string; fullName: string }>;
      owner?: string;
      repo?: string;
    };

    const token = ghConfig.accessToken;
    const owner = ghConfig.selectedRepos?.[0]?.owner ?? ghConfig.owner;
    const repo = ghConfig.selectedRepos?.[0]?.name ?? ghConfig.repo;
    const repoFullName = ghConfig.selectedRepos?.[0]?.fullName ?? `${owner}/${repo}`;

    if (!token || !owner || !repo) {
      return { teamId, repoFullName: repoFullName ?? '', filesIndexed: 0, chunksCreated: 0, skippedFiles: 0, error: 'Missing GitHub credentials' };
    }

    if (!config.OPENAI_API_KEY) {
      return { teamId, repoFullName, filesIndexed: 0, chunksCreated: 0, skippedFiles: 0, error: 'OPENAI_API_KEY not configured — cannot generate embeddings' };
    }

    // 2. Fetch file tree and filter
    let fileTree: GitHubTreeEntry[];
    try {
      fileTree = await githubService.getFileTree(token, owner, repo);
    } catch (err) {
      return { teamId, repoFullName, filesIndexed: 0, chunksCreated: 0, skippedFiles: 0, error: `Failed to fetch file tree: ${err instanceof Error ? err.message : String(err)}` };
    }

    const indexableFiles = fileTree.filter(isIndexableFile).slice(0, MAX_FILES);
    let filesIndexed = 0;
    let skippedFiles = 0;
    const allChunks: Array<{ filePath: string; content: string; chunkIndex: number }> = [];

    // 3. Read files and chunk them
    for (const entry of indexableFiles) {
      try {
        const file = await githubService.getFileContent(token, owner, repo, entry.path);
        const decoded = file.encoding === 'base64'
          ? Buffer.from(file.content, 'base64').toString('utf-8')
          : file.content;

        if (decoded.length > MAX_FILE_SIZE) {
          skippedFiles++;
          continue;
        }

        const chunks = chunkCodeFile(entry.path, decoded);
        for (let i = 0; i < chunks.length; i++) {
          allChunks.push({ filePath: entry.path, content: chunks[i], chunkIndex: i });
        }
        filesIndexed++;
      } catch {
        skippedFiles++;
      }
    }

    if (allChunks.length === 0) {
      return { teamId, repoFullName, filesIndexed: 0, chunksCreated: 0, skippedFiles };
    }

    // 4. Generate embeddings in batches
    const embeddedRows: Array<{
      teamId: string;
      filePath: string;
      content: string;
      embedding: number[];
      repoFullName: string;
      chunkIndex: number;
    }> = [];

    for (let i = 0; i < allChunks.length; i += EMBEDDING_BATCH_SIZE) {
      const batch = allChunks.slice(i, i + EMBEDDING_BATCH_SIZE);
      const texts = batch.map((c) => c.content);
      const embeddings = await embeddingService.generateEmbeddings(texts);

      for (let j = 0; j < batch.length; j++) {
        embeddedRows.push({
          teamId,
          filePath: batch[j].filePath,
          content: batch[j].content,
          embedding: embeddings[j],
          repoFullName,
          chunkIndex: batch[j].chunkIndex,
        });
      }
    }

    // 5. Delete old chunks and insert new ones
    await db.transaction(async (tx) => {
      await tx.delete(codeChunks)
        .where(and(eq(codeChunks.teamId, teamId), eq(codeChunks.repoFullName, repoFullName)));

      // Insert in batches to avoid hitting parameter limits
      const INSERT_BATCH = 100;
      for (let i = 0; i < embeddedRows.length; i += INSERT_BATCH) {
        await tx.insert(codeChunks).values(embeddedRows.slice(i, i + INSERT_BATCH));
      }
    });

    invalidateRelevantCodeCache(teamId);
    return { teamId, repoFullName, filesIndexed, chunksCreated: embeddedRows.length, skippedFiles };
  },

  /**
   * Search code chunks by semantic similarity.
   * Returns the most relevant code snippets for a given query.
   */
  async searchCode(
    query: string,
    teamId: string,
    options?: { topK?: number; threshold?: number },
  ): Promise<Array<{ filePath: string; content: string; score: number; chunkIndex: number }>> {
    const topK = options?.topK ?? 8;
    const threshold = options?.threshold ?? 0.25;

    const [queryEmbedding] = await embeddingService.generateEmbeddings([query]);
    const embeddingLiteral = `[${queryEmbedding.join(',')}]`;

    const { sql } = await import('drizzle-orm');
    const rows = await db.execute<{
      file_path: string;
      content: string;
      score: number;
      chunk_index: number;
    }>(sql`
      SELECT
        file_path,
        content,
        1 - (embedding <=> ${embeddingLiteral}::vector) AS score,
        chunk_index
      FROM code_chunks
      WHERE team_id = ${teamId}
        AND 1 - (embedding <=> ${embeddingLiteral}::vector) >= ${threshold}
      ORDER BY embedding <=> ${embeddingLiteral}::vector ASC
      LIMIT ${topK}
    `);

    return rows.map((row) => ({
      filePath: row.file_path,
      content: row.content,
      score: Number(row.score),
      chunkIndex: row.chunk_index,
    }));
  },

  /**
   * Fetch the most relevant code chunks for a given document, used to ground
   * AI-assisted document edits in the connected codebase.
   *
   * Non-fatal on any failure: if the team has no code chunks indexed, the
   * embedding call fails, or the query times out, returns an empty result
   * rather than throwing. The caller should fall back to an ungrounded prompt.
   */
  async fetchRelevantCodeForDocument(
    documentId: string,
    teamId: string,
  ): Promise<{
    chunks: Array<{ path: string; content: string }>;
    sources: string[];
  }> {
    const EMPTY = { chunks: [], sources: [] as string[] };
    // Soft timeout budget for the whole embed + query step.
    const TIMEOUT_MS = 6000;

    try {
      // 1. Load the document scoped to the team
      const [doc] = await db
        .select({
          id: documents.id,
          title: documents.title,
          content: documents.content,
          teamId: documents.teamId,
        })
        .from(documents)
        .where(and(eq(documents.id, documentId), eq(documents.teamId, teamId)))
        .limit(1);

      if (!doc) {
        console.warn(
          `[code-embedding] fetchRelevantCodeForDocument: document ${documentId} not found for team ${teamId}`,
        );
        return EMPTY;
      }

      // 2. Build the retrieval query string from title + content preview
      const queryText = `${doc.title ?? ''}\n\n${(doc.content ?? '').slice(0, 2000)}`.trim();
      if (!queryText) return EMPTY;

      // 3. Check cache
      const cacheKey = `${teamId}:${documentId}:${_hashContent(queryText)}`;
      _pruneExpired();
      const cached = _relevantCodeCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        // Move to end (MRU position) by re-inserting
        _relevantCodeCache.delete(cacheKey);
        _relevantCodeCache.set(cacheKey, cached);
        cacheMetrics.hits++;
        return cached.result;
      }
      cacheMetrics.misses++;

      // 4. Run embedding + vector search with a soft timeout
      const timeoutPromise = new Promise<typeof EMPTY>((resolve) => {
        setTimeout(() => {
          console.warn(
            `[code-embedding] fetchRelevantCodeForDocument: timed out after ${TIMEOUT_MS}ms for document ${documentId}`,
          );
          resolve(EMPTY);
        }, TIMEOUT_MS);
      });

      const retrievalPromise = (async () => {
        try {
          const results = await this.searchCode(queryText, teamId, {
            topK: 8,
          });
          if (results.length === 0) return EMPTY;

          // De-duplicate by file path while preserving order (highest score first)
          const seen = new Set<string>();
          const chunks: Array<{ path: string; content: string }> = [];
          const sources: string[] = [];
          for (const r of results) {
            chunks.push({ path: r.filePath, content: r.content });
            if (!seen.has(r.filePath)) {
              seen.add(r.filePath);
              sources.push(r.filePath);
            }
          }
          return { chunks, sources };
        } catch (err) {
          console.warn(
            `[code-embedding] fetchRelevantCodeForDocument: retrieval failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          return EMPTY;
        }
      })();

      const result = await Promise.race([retrievalPromise, timeoutPromise]);

      // 5. Cache the result (skip EMPTY to avoid caching timeouts/errors)
      if (result !== EMPTY && result.chunks.length > 0) {
        while (_countEntriesForTeam(teamId) >= MAX_PER_TEAM || _relevantCodeCache.size >= MAX_GLOBAL) {
          _evictLRU();
        }
        _relevantCodeCache.set(cacheKey, {
          result,
          expiresAt: Date.now() + CACHE_TTL_MS,
          teamId,
        });
      }

      return result;
    } catch (err) {
      console.warn(
        `[code-embedding] fetchRelevantCodeForDocument: unexpected error: ${err instanceof Error ? err.message : String(err)}`,
      );
      return EMPTY;
    }
  },
};
