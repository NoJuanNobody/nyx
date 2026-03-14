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
});
