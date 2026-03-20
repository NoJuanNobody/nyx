import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('pdfkit', () => ({
  default: class {
    on(e: string, cb: (...args: any[]) => void) {
      if (e === 'end') setTimeout(cb, 0);
      if (e === 'data') setTimeout(() => cb(Buffer.from('pdf')), 0);
      return this;
    }
    fontSize() { return this; }
    font() { return this; }
    text() { return this; }
    moveDown() { return this; }
    end() {}
  },
}));

vi.mock('docx', () => ({
  Document: class {
    constructor() {}
  },
  Packer: {
    toBuffer: vi.fn().mockResolvedValue(new Uint8Array([0x50, 0x4b, 0x03, 0x04])),
  },
  Paragraph: class {
    constructor() {}
  },
  TextRun: class {
    constructor() {}
  },
  HeadingLevel: {
    TITLE: 'Title',
    HEADING_1: 'Heading1',
    HEADING_2: 'Heading2',
    HEADING_3: 'Heading3',
  },
}));

import { mockDb } from '../helpers/setup.js';
import { makeDocument } from '../helpers/factories.js';
import { exportService } from '../../services/export.service.js';

describe('Export Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('toMarkdown', () => {
    it('returns title and content for existing document', async () => {
      const doc = makeDocument({ title: 'My Doc', content: '# Hello\n\nWorld' });

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([doc]),
        }),
      } as any);

      const result = await exportService.toMarkdown(doc.id);
      expect(result).toEqual({ title: 'My Doc', content: '# Hello\n\nWorld' });
    });

    it('returns null when document not found', async () => {
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as any);

      const result = await exportService.toMarkdown('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('toPdf', () => {
    it('returns title and buffer for existing document', async () => {
      const doc = makeDocument({ title: 'PDF Doc', content: 'Some content' });

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([doc]),
        }),
      } as any);

      const result = await exportService.toPdf(doc.id);
      expect(result).not.toBeNull();
      expect(result!.title).toBe('PDF Doc');
      expect(Buffer.isBuffer(result!.buffer)).toBe(true);
    });

    it('returns null when document not found', async () => {
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as any);

      const result = await exportService.toPdf('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('toPlainText', () => {
    it('returns title and plain text content for existing document', async () => {
      const doc = makeDocument({
        title: 'My Doc',
        content: '# Heading\n\n**Bold text** and *italic*\n\n[Link](http://example.com)',
      });

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([doc]),
        }),
      } as any);

      const result = await exportService.toPlainText(doc.id);
      expect(result).not.toBeNull();
      expect(result!.title).toBe('My Doc');
      // Title line with underline
      expect(result!.content).toContain('My Doc\n======');
      // Markdown stripped
      expect(result!.content).toContain('Heading');
      expect(result!.content).toContain('Bold text and italic');
      expect(result!.content).toContain('Link');
      // Markdown markers removed
      expect(result!.content).not.toContain('**');
      expect(result!.content).not.toContain('[Link]');
    });

    it('returns null when document not found', async () => {
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as any);

      const result = await exportService.toPlainText('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('toDocx', () => {
    it('returns title and buffer for existing document', async () => {
      const doc = makeDocument({ title: 'DOCX Doc', content: '# Hello\n\nSome content' });

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([doc]),
        }),
      } as any);

      const result = await exportService.toDocx(doc.id);
      expect(result).not.toBeNull();
      expect(result!.title).toBe('DOCX Doc');
      expect(Buffer.isBuffer(result!.buffer)).toBe(true);
    });

    it('returns null when document not found', async () => {
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as any);

      const result = await exportService.toDocx('nonexistent');
      expect(result).toBeNull();
    });
  });
});
