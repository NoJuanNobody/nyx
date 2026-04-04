/**
 * Embedding pipeline orchestrator.
 *
 * Ties together chunking, embedding generation, and storage
 * in the doc_chunks table. Called as a fire-and-forget side-effect
 * after document creates/updates.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { docChunks } from '../db/schema.js';
import { config } from '../lib/config.js';
import { chunkText } from './chunking.service.js';
import { embeddingService } from './embedding.service.js';

class EmbeddingPipelineService {
  /**
   * Index a document: chunk its content, generate embeddings, and store them.
   *
   * Old chunks for this document are deleted first so we always have a
   * consistent set matching the current content version.
   */
  async indexDocument(
    documentId: string,
    content: string,
    teamId: string,
    version: number,
  ): Promise<void> {
    // Skip silently when the API key is not configured
    if (!config.OPENAI_API_KEY) {
      return;
    }

    const chunks = chunkText(content);
    if (chunks.length === 0) {
      // Nothing to embed — still clean up old chunks
      await this.removeDocumentChunks(documentId);
      return;
    }

    const embeddings = await embeddingService.generateEmbeddings(chunks);

    // Build rows for batch insert
    const rows = chunks.map((text, idx) => ({
      docId: documentId,
      orgId: teamId,
      content: text,
      embedding: embeddings[idx],
      version,
      chunkIndex: idx,
    }));

    // Transaction: delete old chunks then insert new ones
    await db.transaction(async (tx) => {
      await tx.delete(docChunks).where(eq(docChunks.docId, documentId));
      await tx.insert(docChunks).values(rows);
    });
  }

  /**
   * Remove all stored chunks for a document (e.g. on delete/archive).
   */
  async removeDocumentChunks(documentId: string): Promise<void> {
    await db.delete(docChunks).where(eq(docChunks.docId, documentId));
  }
}

export const embeddingPipelineService = new EmbeddingPipelineService();
