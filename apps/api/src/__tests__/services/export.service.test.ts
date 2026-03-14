import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDb } from '../helpers/setup.js';
import { makeDocument } from '../helpers/factories.js';
import { exportService } from '../../services/export.service.js';

describe('Export Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('toMarkdown', () => {
    it('returns title and content for existing document', async () => {
      const doc = makeDocument({ title: 'My Doc', content: '# Hello' });

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([doc]),
        }),
      } as any);

      const result = await exportService.toMarkdown(doc.id);

      expect(result).not.toBeNull();
      expect(result!.title).toBe('My Doc');
      expect(result!.content).toBe('# Hello');
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

    it('content matches document content exactly', async () => {
      const content = '# Title\n\nSome **markdown** content.';
      const doc = makeDocument({ content });

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([doc]),
        }),
      } as any);

      const result = await exportService.toMarkdown(doc.id);

      expect(result!.content).toBe(content);
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

    it('PDF buffer is non-empty', async () => {
      const doc = makeDocument({ content: 'Hello PDF' });

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([doc]),
        }),
      } as any);

      const result = await exportService.toPdf(doc.id);

      expect(result!.buffer.length).toBeGreaterThan(0);
    });
  });
});
