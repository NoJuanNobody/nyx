import PDFDocument from 'pdfkit';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { documents } from '../db/schema.js';

export const exportService = {
  async toMarkdown(documentId: string): Promise<{ title: string; content: string } | null> {
    const [doc] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, documentId));

    if (!doc) return null;

    return { title: doc.title, content: doc.content };
  },

  async toPdf(documentId: string): Promise<{ title: string; buffer: Buffer } | null> {
    const [doc] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, documentId));

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
      pdfDoc
        .fontSize(24)
        .font('Helvetica-Bold')
        .text(doc.title, { align: 'left' });

      pdfDoc.moveDown();

      // Content
      pdfDoc
        .fontSize(12)
        .font('Helvetica')
        .text(doc.content, { align: 'left' });

      pdfDoc.end();
    });
  },
};
