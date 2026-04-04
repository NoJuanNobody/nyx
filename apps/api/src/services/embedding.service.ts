/**
 * Embedding service — generates vector embeddings via OpenAI.
 *
 * Uses the text-embedding-3-small model (1536 dimensions) which matches
 * the pgvector column defined in the doc_chunks table.
 */

import OpenAI from 'openai';
import { config } from '../lib/config.js';

const MODEL = 'text-embedding-3-small';

class EmbeddingService {
  private getClient(): OpenAI {
    if (!config.OPENAI_API_KEY) {
      throw new Error(
        'OPENAI_API_KEY is not configured — embeddings are unavailable',
      );
    }
    return new OpenAI({ apiKey: config.OPENAI_API_KEY });
  }

  /**
   * Generate embeddings for an array of text strings.
   * OpenAI's embedding endpoint natively supports batching,
   * so we send all texts in a single request.
   *
   * @returns An array of number arrays, one embedding per input text.
   */
  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const client = this.getClient();
    const response = await client.embeddings.create({
      model: MODEL,
      input: texts,
    });

    // The API returns embeddings in the same order as the input
    return response.data
      .sort((a, b) => a.index - b.index)
      .map((item) => item.embedding);
  }
}

export const embeddingService = new EmbeddingService();
