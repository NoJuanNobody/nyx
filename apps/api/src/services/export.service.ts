import PDFDocument from 'pdfkit';
import {
  Document as DocxDocument,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
} from 'docx';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { documents } from '../db/schema.js';

/**
 * Strip basic markdown formatting to produce plain text.
 */
function markdownToPlainText(markdown: string): string {
  return (
    markdown
      // Remove headings (# symbols)
      .replace(/^#{1,6}\s+/gm, '')
      // Remove bold/italic markers
      .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
      .replace(/_{1,3}([^_]+)_{1,3}/g, '$1')
      // Remove inline code backticks
      .replace(/`([^`]+)`/g, '$1')
      // Remove link syntax [text](url) -> text
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      // Remove image syntax ![alt](url) -> alt
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
      // Remove blockquote markers
      .replace(/^>\s?/gm, '')
      // Remove horizontal rules
      .replace(/^[-*_]{3,}\s*$/gm, '')
      // Collapse multiple blank lines
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/**
 * Convert markdown content into an array of docx Paragraphs.
 */
function markdownToDocxParagraphs(title: string, content: string): Paragraph[] {
  const paragraphs: Paragraph[] = [
    new Paragraph({
      text: title,
      heading: HeadingLevel.TITLE,
    }),
  ];

  const lines = content.split('\n');
  for (const line of lines) {
    const h1 = line.match(/^#\s+(.*)/);
    if (h1) {
      paragraphs.push(new Paragraph({ text: h1[1], heading: HeadingLevel.HEADING_1 }));
      continue;
    }
    const h2 = line.match(/^##\s+(.*)/);
    if (h2) {
      paragraphs.push(new Paragraph({ text: h2[1], heading: HeadingLevel.HEADING_2 }));
      continue;
    }
    const h3 = line.match(/^###\s+(.*)/);
    if (h3) {
      paragraphs.push(new Paragraph({ text: h3[1], heading: HeadingLevel.HEADING_3 }));
      continue;
    }

    // Bold handling within a line
    const parts = line.split(/(\*\*[^*]+\*\*)/g);
    const runs: TextRun[] = parts
      .filter((p) => p.length > 0)
      .map((part) => {
        const boldMatch = part.match(/^\*\*(.+)\*\*$/);
        if (boldMatch) {
          return new TextRun({ text: boldMatch[1], bold: true });
        }
        return new TextRun({ text: part });
      });

    paragraphs.push(new Paragraph({ children: runs }));
  }

  return paragraphs;
}

export const exportService = {
  async toMarkdown(documentId: string): Promise<{ title: string; content: string } | null> {
    const [doc] = await db.select().from(documents).where(eq(documents.id, documentId));

    if (!doc) return null;

    return { title: doc.title, content: doc.content };
  },

  async toPdf(documentId: string): Promise<{ title: string; buffer: Buffer } | null> {
    const [doc] = await db.select().from(documents).where(eq(documents.id, documentId));

    if (!doc) return null;

    return new Promise((resolve, reject) => {
      const pdfDoc = new PDFDocument({ margin: 50 });
      const chunks: Uint8Array[] = [];

      pdfDoc.on('data', (chunk: Uint8Array) => chunks.push(chunk));
      pdfDoc.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({ title: doc.title, buffer });
      });
      pdfDoc.on('error', reject);

      // Title
      pdfDoc.fontSize(24).font('Helvetica-Bold').text(doc.title, { align: 'left' });

      pdfDoc.moveDown();

      // Content
      pdfDoc.fontSize(12).font('Helvetica').text(doc.content, { align: 'left' });

      pdfDoc.end();
    });
  },

  async toPlainText(documentId: string): Promise<{ title: string; content: string } | null> {
    const [doc] = await db.select().from(documents).where(eq(documents.id, documentId));

    if (!doc) return null;

    const plainText = `${doc.title}\n${'='.repeat(doc.title.length)}\n\n${markdownToPlainText(doc.content)}`;
    return { title: doc.title, content: plainText };
  },

  async toDocx(documentId: string): Promise<{ title: string; buffer: Buffer } | null> {
    const [doc] = await db.select().from(documents).where(eq(documents.id, documentId));

    if (!doc) return null;

    const docxDoc = new DocxDocument({
      sections: [
        {
          children: markdownToDocxParagraphs(doc.title, doc.content),
        },
      ],
    });

    const buffer = Buffer.from(await Packer.toBuffer(docxDoc));
    return { title: doc.title, buffer };
  },
};
