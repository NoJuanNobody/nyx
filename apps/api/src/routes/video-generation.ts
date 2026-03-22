import { createReadStream, existsSync } from 'fs';
import { join } from 'path';
import type { FastifyPluginAsync } from 'fastify';
import { videoGenerationService } from '../services/video-generation.service.js';

const VIDEO_OUTPUT_DIR = join(process.cwd(), 'generated-videos');

export const videoGenerationRoutes: FastifyPluginAsync = async (app) => {
  // POST /api/video/generate — generate a video from prompt
  app.post('/generate', async (request, reply) => {
    const { prompt, documentId, duration, aspectRatio } = request.body as {
      prompt?: string;
      documentId?: string;
      duration?: number;
      aspectRatio?: '16:9' | '9:16' | '1:1';
    };

    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
      reply.code(400);
      return { error: 'prompt is required' };
    }

    const video = await videoGenerationService.generateVideo({
      prompt: prompt.trim(),
      documentId,
      duration,
      aspectRatio,
    });

    return video;
  });

  // GET /api/video/:id — get video status
  app.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const video = await videoGenerationService.getVideoStatus(id);
    if (!video) {
      reply.code(404);
      return { error: 'Video not found' };
    }

    return video;
  });

  // GET /api/video?documentId=X — list videos for document
  app.get('/', async (request, reply) => {
    const { documentId } = request.query as { documentId?: string };

    if (!documentId) {
      reply.code(400);
      return { error: 'documentId query parameter is required' };
    }

    const videos = await videoGenerationService.listVideos(documentId);
    return { videos };
  });

  // GET /api/video/file/:fileName — serve generated video files
  app.get('/file/:fileName', async (request, reply) => {
    const { fileName } = request.params as { fileName: string };
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '');
    const filePath = join(VIDEO_OUTPUT_DIR, safeName);

    if (!existsSync(filePath)) {
      reply.code(404);
      return { error: 'Video file not found' };
    }

    reply
      .header('Content-Type', 'video/mp4')
      .header('Content-Disposition', `inline; filename="${safeName}"`);

    return reply.send(createReadStream(filePath));
  });

  // POST /api/video/batch-download — accepts { videoIds: string[] }, returns zip
  app.post('/batch-download', async (request, reply) => {
    const { videoIds } = request.body as { videoIds?: string[] };

    if (!videoIds || !Array.isArray(videoIds) || videoIds.length === 0) {
      reply.code(400);
      return { error: 'videoIds must be a non-empty array' };
    }

    const zipBuffer = await videoGenerationService.generateBatchZip(videoIds);

    if (!zipBuffer) {
      reply.code(404);
      return { error: 'No downloadable videos found. Videos generated without an API key cannot be downloaded.' };
    }

    reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', 'attachment; filename="nyx-videos.zip"');

    return reply.send(zipBuffer);
  });
};
