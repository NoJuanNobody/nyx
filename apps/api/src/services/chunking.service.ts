/**
 * Text chunking service for document embedding pipeline.
 *
 * Splits document content into overlapping chunks suitable for
 * vector embedding. Respects paragraph and sentence boundaries
 * to preserve semantic coherence.
 */

export interface ChunkOptions {
  /** Approximate max characters per chunk (default ~2000 ≈ 500 tokens) */
  chunkSize?: number;
  /** Overlap characters between consecutive chunks (default ~200 ≈ 50 tokens) */
  overlap?: number;
}

const DEFAULT_CHUNK_SIZE = 2000;
const DEFAULT_OVERLAP = 200;

/**
 * Split text into overlapping chunks, preferring paragraph then sentence boundaries.
 */
export function chunkText(
  content: string,
  options?: ChunkOptions,
): string[] {
  const chunkSize = options?.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const overlap = options?.overlap ?? DEFAULT_OVERLAP;

  if (!content || content.trim().length === 0) {
    return [];
  }

  // If the entire content fits in one chunk, return it directly
  if (content.length <= chunkSize) {
    return [content];
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < content.length) {
    let end = Math.min(start + chunkSize, content.length);

    // If we haven't reached the end of the content, try to break at a natural boundary
    if (end < content.length) {
      end = findBreakPoint(content, start, end);
    }

    const chunk = content.slice(start, end).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }

    // Advance start, applying overlap
    const advance = end - start - overlap;
    start += Math.max(advance, 1); // always advance at least 1 char to avoid infinite loops
  }

  return chunks;
}

/**
 * Find the best break point in `content` between `start` and `end`.
 * Prefers paragraph boundaries (\n\n), then sentence boundaries (. ! ?), then whitespace.
 */
function findBreakPoint(content: string, start: number, end: number): number {
  const window = content.slice(start, end);

  // Look for the last paragraph boundary (double newline) in the back half of the window
  const halfPoint = Math.floor(window.length / 2);
  const lastParagraph = window.lastIndexOf('\n\n', window.length);
  if (lastParagraph > halfPoint) {
    return start + lastParagraph + 2; // include the double newline
  }

  // Look for the last sentence-ending punctuation followed by whitespace
  const sentencePattern = /[.!?]\s/g;
  let lastSentence = -1;
  let match: RegExpExecArray | null;
  while ((match = sentencePattern.exec(window)) !== null) {
    if (match.index > halfPoint) {
      lastSentence = match.index;
    }
  }
  if (lastSentence > halfPoint) {
    return start + lastSentence + 2; // include punctuation + space
  }

  // Fall back to the last whitespace
  const lastSpace = window.lastIndexOf(' ');
  if (lastSpace > halfPoint) {
    return start + lastSpace + 1;
  }

  // No good boundary found — hard cut
  return end;
}
