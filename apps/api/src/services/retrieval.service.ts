/**
 * Vector similarity search — retrieves the most relevant document chunks
 * for a given natural-language query using pgvector cosine distance.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { embeddingService } from './embedding.service.js';

export interface RetrievedChunk {
  content: string;
  docId: string;
  score: number;
  chunkIndex: number;
}

/**
 * Embed the query and return the top-K most similar document chunks
 * belonging to the given team/org.
 */
export async function retrieveChunks(
  query: string,
  teamId: string,
  options?: { topK?: number; threshold?: number },
): Promise<RetrievedChunk[]> {
  const topK = options?.topK ?? 5;
  const threshold = options?.threshold ?? 0.3;

  // Generate embedding for the search query
  const [queryEmbedding] = await embeddingService.generateEmbeddings([query]);

  // Format the embedding as a pgvector literal: '[0.1,0.2,...]'
  const embeddingLiteral = `[${queryEmbedding.join(',')}]`;

  // Cosine similarity = 1 - cosine distance (<=> operator)
  const rows = await db.execute<{
    content: string;
    doc_id: string;
    score: number;
    chunk_index: number;
  }>(sql`
    SELECT
      content,
      doc_id,
      1 - (embedding <=> ${embeddingLiteral}::vector) AS score,
      chunk_index
    FROM doc_chunks
    WHERE org_id = ${teamId}
      AND 1 - (embedding <=> ${embeddingLiteral}::vector) >= ${threshold}
    ORDER BY embedding <=> ${embeddingLiteral}::vector ASC
    LIMIT ${topK}
  `);

  return rows.map((row) => ({
    content: row.content,
    docId: row.doc_id,
    score: Number(row.score),
    chunkIndex: row.chunk_index,
  }));
}
