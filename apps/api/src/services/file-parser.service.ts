/**
 * File parser service — converts uploaded file buffers into Nyx document content.
 *
 * Supported formats:
 *  - .txt, .md  → direct text import
 *  - .csv       → parsed into a markdown table
 *  - other      → raw text with a note about the unsupported format
 */

export interface ParsedFile {
  content: string;
  note?: string;
}

const SUPPORTED_TEXT_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/x-markdown',
]);

const CSV_TYPES = new Set([
  'text/csv',
  'application/csv',
]);

/**
 * Parse a row of CSV respecting quoted fields that may contain commas or newlines.
 */
function parseCsvRow(row: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < row.length; i++) {
    const char = row[i];

    if (inQuotes) {
      if (char === '"') {
        // Peek ahead for escaped quote
        if (i + 1 < row.length && row[i + 1] === '"') {
          current += '"';
          i++; // skip next quote
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        fields.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
  }

  fields.push(current.trim());
  return fields;
}

/**
 * Convert CSV text into a markdown table.
 */
function csvToMarkdownTable(csv: string): string {
  const lines = csv
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);

  if (lines.length === 0) return '';

  const rows = lines.map(parseCsvRow);
  const headerRow = rows[0];
  const dataRows = rows.slice(1);

  const header = `| ${headerRow.join(' | ')} |`;
  const separator = `| ${headerRow.map(() => '---').join(' | ')} |`;
  const body = dataRows.map((row) => `| ${row.join(' | ')} |`).join('\n');

  return [header, separator, body].filter(Boolean).join('\n');
}

/**
 * Infer MIME type from filename extension when the provided MIME is generic
 * (e.g., application/octet-stream).
 */
function refineMimeType(mimeType: string, filename?: string): string {
  if (
    mimeType !== 'application/octet-stream' &&
    mimeType !== '' &&
    mimeType !== 'unknown'
  ) {
    return mimeType;
  }

  if (!filename) return mimeType;

  const ext = filename.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'txt':
      return 'text/plain';
    case 'md':
    case 'markdown':
      return 'text/markdown';
    case 'csv':
      return 'text/csv';
    default:
      return mimeType;
  }
}

/**
 * Parse an uploaded file buffer and return its content as markdown-compatible text.
 */
export function parseFile(
  buffer: Buffer,
  mimeType: string,
  filename?: string,
): ParsedFile {
  const resolvedMime = refineMimeType(mimeType, filename);
  const text = buffer.toString('utf-8');

  if (SUPPORTED_TEXT_TYPES.has(resolvedMime)) {
    return { content: text };
  }

  if (CSV_TYPES.has(resolvedMime)) {
    const table = csvToMarkdownTable(text);
    return { content: table };
  }

  // Fallback: return raw text with a note
  return {
    content: text,
    note: `File type "${resolvedMime}" is not fully supported. Content was imported as raw text.`,
  };
}

export const fileParserService = { parseFile };
