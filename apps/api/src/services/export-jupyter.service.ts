import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { documents } from '../db/schema.js';

interface NotebookCell {
  cell_type: 'markdown' | 'code';
  metadata: Record<string, unknown>;
  source: string[];
  outputs?: unknown[];
  execution_count?: null;
}

interface Notebook {
  nbformat: number;
  nbformat_minor: number;
  metadata: {
    kernelspec: { display_name: string; language: string; name: string };
    language_info: { name: string; version: string };
    title?: string;
    [key: string]: unknown;
  };
  cells: NotebookCell[];
}

/**
 * Split lines into an array where each element ends with '\n',
 * except possibly the last line.
 */
function toSourceLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  return lines.map((line, i) => (i < lines.length - 1 ? line + '\n' : line));
}

/**
 * Converts markdown text to a Jupyter notebook (nbformat v4) JSON object.
 *
 * Fenced code blocks (```language ... ```) become code cells.
 * Everything else becomes markdown cells, with consecutive non-code lines
 * grouped into single markdown cells.
 */
export function markdownToNotebook(markdown: string, title: string = 'Untitled'): Notebook {
  const lines = markdown.split('\n');
  const cells: NotebookCell[] = [];
  let i = 0;
  let markdownBuffer: string[] = [];

  function flushMarkdown() {
    if (markdownBuffer.length === 0) return;
    // Join then re-split to get proper source lines
    const text = markdownBuffer.join('\n');
    cells.push({
      cell_type: 'markdown',
      metadata: {},
      source: toSourceLines(text),
    });
    markdownBuffer = [];
  }

  while (i < lines.length) {
    const line = lines[i];
    const codeMatch = line.match(/^```(\w*)/);

    if (codeMatch) {
      flushMarkdown();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```

      const text = codeLines.join('\n');
      cells.push({
        cell_type: 'code',
        metadata: {},
        source: toSourceLines(text),
        outputs: [],
        execution_count: null,
      });
      continue;
    }

    markdownBuffer.push(line);
    i++;
  }

  flushMarkdown();

  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python', version: '3.11.0' },
      title,
    },
    cells,
  };
}

export const exportJupyterService = {
  async toJupyterNotebook(
    documentId: string,
  ): Promise<{ title: string; content: object } | null> {
    const [doc] = await db.select().from(documents).where(eq(documents.id, documentId));

    if (!doc) return null;

    const notebook = markdownToNotebook(doc.content, doc.title);
    return { title: doc.title, content: notebook };
  },
};
