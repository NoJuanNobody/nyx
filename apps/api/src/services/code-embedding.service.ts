/**
 * Code Embedding Pipeline — indexes code from connected GitHub repos
 * into the code_chunks table for RAG-powered codebase search.
 *
 * Flow: fetch file tree → filter relevant files → chunk → embed → store
 */

import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { codeChunks, integrations } from '../db/schema.js';
import { githubService, type GitHubTreeEntry } from './github.service.js';
import { chunkText } from './chunking.service.js';
import { embeddingService } from './embedding.service.js';
import { config } from '../lib/config.js';

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
};
