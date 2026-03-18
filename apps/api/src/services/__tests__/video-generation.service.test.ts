import { describe, it, expect, beforeEach } from 'vitest';
import { videoGenerationService } from '../video-generation.service.js';

describe('videoGenerationService', () => {
  beforeEach(() => {
    videoGenerationService._reset();
  });

  describe('generateVideo', () => {
    it('should return a valid GeneratedVideo object', async () => {
      const video = await videoGenerationService.generateVideo({
        prompt: 'A product demo showing the dashboard',
        documentId: 'doc-123',
        duration: 10,
        aspectRatio: '16:9',
      });

      expect(video).toMatchObject({
        prompt: 'A product demo showing the dashboard',
        status: 'completed',
        duration: 10,
        documentId: 'doc-123',
      });
      expect(video.id).toBeDefined();
      expect(typeof video.id).toBe('string');
      expect(video.videoUrl).toBeTruthy();
      expect(video.thumbnailUrl).toBeTruthy();
      expect(video.createdAt).toBeTruthy();
    });

    it('should default duration to 5 seconds', async () => {
      const video = await videoGenerationService.generateVideo({
        prompt: 'A short clip',
      });

      expect(video.duration).toBe(5);
    });
  });

  describe('getVideoStatus', () => {
    it('should return null for unknown ID', async () => {
      const result = await videoGenerationService.getVideoStatus('non-existent-id');
      expect(result).toBeNull();
    });

    it('should return a previously generated video', async () => {
      const video = await videoGenerationService.generateVideo({
        prompt: 'test video',
      });

      const fetched = await videoGenerationService.getVideoStatus(video.id);
      expect(fetched).toEqual(video);
    });
  });

  describe('listVideos', () => {
    it('should filter by documentId', async () => {
      await videoGenerationService.generateVideo({
        prompt: 'video A',
        documentId: 'doc-1',
      });
      await videoGenerationService.generateVideo({
        prompt: 'video B',
        documentId: 'doc-2',
      });
      await videoGenerationService.generateVideo({
        prompt: 'video C',
        documentId: 'doc-1',
      });

      const doc1Videos = await videoGenerationService.listVideos('doc-1');
      expect(doc1Videos).toHaveLength(2);
      expect(doc1Videos.every((v) => v.documentId === 'doc-1')).toBe(true);

      const doc2Videos = await videoGenerationService.listVideos('doc-2');
      expect(doc2Videos).toHaveLength(1);

      const noVideos = await videoGenerationService.listVideos('doc-999');
      expect(noVideos).toHaveLength(0);
    });
  });

  describe('generateBatchZip', () => {
    it('should return a Buffer', async () => {
      const v1 = await videoGenerationService.generateVideo({
        prompt: 'first video',
        documentId: 'doc-1',
      });
      const v2 = await videoGenerationService.generateVideo({
        prompt: 'second video',
        documentId: 'doc-1',
      });

      const zip = await videoGenerationService.generateBatchZip([v1.id, v2.id]);
      expect(Buffer.isBuffer(zip)).toBe(true);
      expect(zip.length).toBeGreaterThan(0);
    });

    it('should handle empty results gracefully', async () => {
      const zip = await videoGenerationService.generateBatchZip(['non-existent']);
      expect(Buffer.isBuffer(zip)).toBe(true);
    });
  });
});
