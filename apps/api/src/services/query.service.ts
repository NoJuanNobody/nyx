/**
 * RAG query service — retrieves relevant document chunks and streams
 * an AI-generated answer using Claude.
 */

import { retrieveChunks } from './retrieval.service.js';
import { createPlatformLlmClient, DEFAULT_MODEL } from '../lib/llm.js';

const MODEL = DEFAULT_MODEL;

/**
 * Retrieve relevant chunks for a query, feed them as context to Claude,
 * and yield streamed text deltas as an async generator.
 */
export async function* queryDocs(
  query: string,
  teamId: string,
): AsyncGenerator<string> {
  // 1. Retrieve relevant document chunks via vector search
  const chunks = await retrieveChunks(query, teamId, { topK: 8 });

  if (chunks.length === 0) {
    yield 'No relevant documentation found for your query.';
    return;
  }

  // 2. Build context from retrieved chunks
  const context = chunks
    .map((c, i) => `[Chunk ${i + 1} | doc:${c.docId} | score:${c.score.toFixed(2)}]\n${c.content}`)
    .join('\n\n---\n\n');

  // 3. Stream response from Claude
  const client = createPlatformLlmClient();
  if (!client) {
    yield 'Error: no LLM provider key is configured.';
    return;
  }

  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 2048,
    system: `You are a documentation assistant for the Nyx platform. Answer the user's question based ONLY on the provided documentation context. If the context doesn't contain enough information to answer, say so clearly. Be concise and cite relevant document sections when possible.`,
    messages: [
      {
        role: 'user',
        content: `Context from documentation:\n\n${context}\n\n---\n\nQuestion: ${query}`,
      },
    ],
  });

  for await (const event of stream) {
    if (
      event.type === 'content_block_delta' &&
      event.delta.type === 'text_delta'
    ) {
      yield event.delta.text;
    }
  }
}
