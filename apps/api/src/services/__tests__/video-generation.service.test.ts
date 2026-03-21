import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the database
const mockInsert = vi.fn().mockReturnValue({
  values: vi.fn().mockReturnValue({
    returning: vi.fn().mockResolvedValue([{
      id: 'test-uuid',
      prompt: 'test prompt',
      status: 'completed',
      videoUrl: 'https://nyx-placeholder.test/videos/stub.mp4',
      thumbnailUrl: null,
      duration: 5,
      createdAt: new Date(),
      documentId: null,
      error: null,
    }]),
  }),
});

const mockSelect = vi.fn().mockReturnValue({
  from: vi.fn().mockReturnValue({
    where: vi.fn().mockResolvedValue([]),
  }),
});

vi.mock('../../db/index.js', () => ({
  db: {
    insert: (...args: unknown[]) => mockInsert(...args),
    select: (...args: unknown[]) => mockSelect(...args),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
  },
}));

vi.mock('../../lib/config.js', () => ({
  config: { GOOGLE_AI_API_KEY: undefined },
}));

const { videoGenerationService } = await import('../video-generation.service.js');

describe('videoGenerationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('generateVideo', () => {
    it('returns a valid GeneratedVideo object in stub mode', async () => {
      const video = await videoGenerationService.generateVideo({
        prompt: 'A product demo',
      });

      expect(video).toHaveProperty('id');
      expect(video).toHaveProperty('prompt');
      expect(video).toHaveProperty('status');
      expect(video).toHaveProperty('createdAt');
      expect(video.status).toBe('completed');
    });

    it('uses default duration of 5 seconds', async () => {
      const video = await videoGenerationService.generateVideo({
        prompt: 'test',
      });

      expect(video.duration).toBe(5);
    });
  });

  describe('getVideoStatus', () => {
    it('returns null for unknown ID', async () => {
      const video = await videoGenerationService.getVideoStatus('nonexistent');
      expect(video).toBeNull();
    });
  });

  describe('listVideos', () => {
    it('returns empty array when no videos exist', async () => {
      const videos = await videoGenerationService.listVideos('doc-123');
      expect(videos).toEqual([]);
    });
  });

  describe('generateBatchZip', () => {
    it('returns null when no downloadable videos are found', async () => {
      const result = await videoGenerationService.generateBatchZip([]);
      expect(result).toBeNull();
    });
  });
});
