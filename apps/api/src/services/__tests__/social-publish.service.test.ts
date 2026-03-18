import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('socialPublishService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  function mockDb() {
    const returning = vi.fn().mockResolvedValue([
      {
        id: 'post-1',
        documentId: 'doc-1',
        platform: 'twitter',
        content: 'Hello world',
        postUrl: 'https://twitter.com/i/status/abc123',
        status: 'published',
        publishedAt: new Date(),
        createdAt: new Date(),
      },
    ]);

    const values = vi.fn().mockReturnValue({ returning });
    const insertFn = vi.fn().mockReturnValue({ values });

    const orderBy = vi.fn().mockResolvedValue([
      {
        id: 'post-1',
        documentId: 'doc-1',
        platform: 'twitter',
        content: 'Hello world',
        postUrl: 'https://twitter.com/i/status/abc123',
        status: 'published',
        publishedAt: new Date(),
        createdAt: new Date(),
      },
    ]);
    const where = vi.fn().mockReturnValue({ orderBy });
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });

    vi.doMock('../../db/index.js', () => ({
      db: { insert: insertFn, select },
    }));

    return { insertFn, values, returning, select, from, where, orderBy };
  }

  async function loadService() {
    mockDb();
    vi.doMock('../../db/schema.js', () => ({
      socialPosts: { documentId: 'document_id' },
    }));
    const mod = await import('../social-publish.service.js');
    return mod.socialPublishService;
  }

  // ── publishToTwitter ─────────────────────────────────

  describe('publishToTwitter', () => {
    it('should return a mock post URL for valid content', async () => {
      const service = await loadService();
      const result = await service.publishToTwitter('Hello world', 'token-123');

      expect(result.platform).toBe('twitter');
      expect(result.status).toBe('published');
      expect(result.postUrl).toMatch(/^https:\/\/twitter\.com\/i\/status\//);
    });

    it('should reject empty content', async () => {
      const service = await loadService();

      await expect(service.publishToTwitter('', 'token-123')).rejects.toThrow(
        'Content is required',
      );
    });

    it('should reject whitespace-only content', async () => {
      const service = await loadService();

      await expect(service.publishToTwitter('   ', 'token-123')).rejects.toThrow(
        'Content is required',
      );
    });

    it('should reject content exceeding 280 characters', async () => {
      const service = await loadService();
      const longContent = 'a'.repeat(281);

      await expect(service.publishToTwitter(longContent, 'token-123')).rejects.toThrow(
        'Content exceeds Twitter character limit of 280',
      );
    });

    it('should accept content at exactly 280 characters', async () => {
      const service = await loadService();
      const exactContent = 'a'.repeat(280);

      const result = await service.publishToTwitter(exactContent, 'token-123');
      expect(result.status).toBe('published');
    });

    it('should reject missing access token', async () => {
      const service = await loadService();

      await expect(service.publishToTwitter('Hello', '')).rejects.toThrow(
        'Access token is required for Twitter publishing',
      );
    });
  });

  // ── publishToLinkedIn ────────────────────────────────

  describe('publishToLinkedIn', () => {
    it('should return a mock post URL for valid content', async () => {
      const service = await loadService();
      const result = await service.publishToLinkedIn('Professional update', 'token-456');

      expect(result.platform).toBe('linkedin');
      expect(result.status).toBe('published');
      expect(result.postUrl).toMatch(/^https:\/\/www\.linkedin\.com\/feed\/update\//);
    });

    it('should reject content exceeding 3000 characters', async () => {
      const service = await loadService();
      const longContent = 'a'.repeat(3001);

      await expect(service.publishToLinkedIn(longContent, 'token-456')).rejects.toThrow(
        'Content exceeds LinkedIn character limit of 3000',
      );
    });

    it('should accept content at exactly 3000 characters', async () => {
      const service = await loadService();
      const exactContent = 'a'.repeat(3000);

      const result = await service.publishToLinkedIn(exactContent, 'token-456');
      expect(result.status).toBe('published');
    });

    it('should reject missing access token', async () => {
      const service = await loadService();

      await expect(service.publishToLinkedIn('Hello', '')).rejects.toThrow(
        'Access token is required for LinkedIn publishing',
      );
    });
  });

  // ── publish (dispatcher) ─────────────────────────────

  describe('publish', () => {
    it('should route to Twitter handler', async () => {
      const service = await loadService();
      const result = await service.publish('twitter', 'Tweet this', 'token');

      expect(result.platform).toBe('twitter');
      expect(result.status).toBe('published');
    });

    it('should route to LinkedIn handler', async () => {
      const service = await loadService();
      const result = await service.publish('linkedin', 'Post this', 'token');

      expect(result.platform).toBe('linkedin');
      expect(result.status).toBe('published');
    });

    it('should reject unsupported platforms', async () => {
      const service = await loadService();

      await expect(
        service.publish('facebook' as 'twitter', 'content', 'token'),
      ).rejects.toThrow('Unsupported platform: facebook');
    });
  });

  // ── savePost ─────────────────────────────────────────

  describe('savePost', () => {
    it('should insert a record and return it', async () => {
      const mocks = mockDb();
      vi.doMock('../../db/schema.js', () => ({
        socialPosts: { documentId: 'document_id' },
      }));
      const { socialPublishService: service } = await import('../social-publish.service.js');

      const result = await service.savePost(
        'doc-1',
        'twitter',
        'Hello world',
        'published',
        'https://twitter.com/i/status/abc123',
      );

      expect(mocks.insertFn).toHaveBeenCalled();
      expect(mocks.values).toHaveBeenCalledWith(
        expect.objectContaining({
          documentId: 'doc-1',
          platform: 'twitter',
          content: 'Hello world',
          status: 'published',
          postUrl: 'https://twitter.com/i/status/abc123',
        }),
      );
      expect(result.id).toBe('post-1');
    });

    it('should set postUrl to null when not provided', async () => {
      const mocks = mockDb();
      vi.doMock('../../db/schema.js', () => ({
        socialPosts: { documentId: 'document_id' },
      }));
      const { socialPublishService: service } = await import('../social-publish.service.js');

      await service.savePost('doc-1', 'twitter', 'Hello', 'draft');

      expect(mocks.values).toHaveBeenCalledWith(
        expect.objectContaining({
          postUrl: null,
          publishedAt: null,
        }),
      );
    });
  });

  // ── getPublishHistory ────────────────────────────────

  describe('getPublishHistory', () => {
    it('should return posts for a given document', async () => {
      const mocks = mockDb();
      vi.doMock('../../db/schema.js', () => ({
        socialPosts: { documentId: 'document_id' },
      }));
      const { socialPublishService: service } = await import('../social-publish.service.js');

      const results = await service.getPublishHistory('doc-1');

      expect(mocks.select).toHaveBeenCalled();
      expect(Array.isArray(results)).toBe(true);
      expect(results[0].documentId).toBe('doc-1');
    });
  });
});
