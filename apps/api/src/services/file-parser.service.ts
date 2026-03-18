const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export type ParseResult = {
  content: string;
  title?: string;
};

const SUPPORTED_EXTENSIONS = ['txt', 'md', 'csv', 'docx', 'pdf', 'xlsx'];

function csvToMarkdownTable(csvText: string): string {
  const lines = csvText
    .trim()
    .split('\n')
    .map((line) =>
      line
        .split(',')
        .map((cell) => cell.trim().replace(/^"|"$/g, '').replace(/"/g, '')),
    );

  if (lines.length === 0) return '';

  const header = lines[0];
  const separator = header.map(() => '---');
  const rows = lines.slice(1);

  const headerRow = `| ${header.join(' | ')} |`;
  const sepRow = `| ${separator.join(' | ')} |`;
  const bodyRows = rows.map((row) => `| ${row.join(' | ')} |`);

  return [headerRow, sepRow, ...bodyRows].join('\n');
}

async function parseTxt(buffer: Buffer): Promise<ParseResult> {
  return { content: buffer.toString('utf-8') };
}

async function parseCsv(buffer: Buffer): Promise<ParseResult> {
  const csvText = buffer.toString('utf-8');
  return { content: csvToMarkdownTable(csvText) };
}

async function parseDocx(buffer: Buffer): Promise<ParseResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mammoth = (await import('mammoth')) as any;
  const result = await mammoth.extractRawText({ buffer });
  return { content: result.value as string };
}

async function parsePdf(buffer: Buffer): Promise<ParseResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfParse = (await import('pdf-parse')) as any;
  const fn = pdfParse.default ?? pdfParse;
  const data = await fn(buffer);
  return {
    content: data.text as string,
    title: (data.info?.Title as string) || undefined,
  };
}

async function parseXlsx(buffer: Buffer): Promise<ParseResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const XLSX = (await import('xlsx')) as any;
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sections: string[] = [];

  for (const sheetName of workbook.SheetNames as string[]) {
    const sheet = workbook.Sheets[sheetName];
    const csv = XLSX.utils.sheet_to_csv(sheet) as string;
    sections.push(`## ${sheetName}\n\n${csvToMarkdownTable(csv)}`);
  }

  return { content: sections.join('\n\n') };
}

export function validateFile(
  filename: string,
  size: number,
): { valid: boolean; error?: string } {
  if (size > MAX_FILE_SIZE) {
    return { valid: false, error: 'File size exceeds 10MB limit.' };
  }

  const ext = filename.toLowerCase().split('.').pop() ?? '';
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    return {
      valid: false,
      error: `Unsupported file type ".${ext}". Supported: ${SUPPORTED_EXTENSIONS.map((e) => `.${e}`).join(', ')}.`,
    };
  }

  return { valid: true };
}

export async function parseFile(
  buffer: Buffer,
  filename: string,
): Promise<ParseResult> {
  const ext = filename.toLowerCase().split('.').pop() ?? '';

  switch (ext) {
    case 'txt':
    case 'md':
      return parseTxt(buffer);
    case 'csv':
      return parseCsv(buffer);
    case 'docx':
      return parseDocx(buffer);
    case 'pdf':
      return parsePdf(buffer);
    case 'xlsx':
      return parseXlsx(buffer);
    default:
      return parseTxt(buffer);
  }
}

export const fileParserService = {
  validateFile,
  parseFile,
};
