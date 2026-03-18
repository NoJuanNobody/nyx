import type { FastifyPluginAsync } from 'fastify';
import multipart from '@fastify/multipart';
import { requireRole } from '../middleware/permissions.js';
import { fileParserService } from '../services/file-parser.service.js';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export const documentUploadRoutes: FastifyPluginAsync = async (app) => {
  await app.register(multipart, {
    limits: { fileSize: MAX_FILE_SIZE },
  });

  // POST /api/documents/:id/upload — upload a file and parse it into markdown content
  // editors+ can upload
  app.post(
    '/:id/upload',
    { preHandler: [requireRole({ minimumRole: 'editor', source: 'document' })] },
    async (request, reply) => {
      const data = await request.file();

      if (!data) {
        reply.code(400);
        return { error: 'No file uploaded.' };
      }

      const buffer = await data.toBuffer();
      const filename = data.filename;

      const validation = fileParserService.validateFile(filename, buffer.length);
      if (!validation.valid) {
        reply.code(400);
        return { error: validation.error };
      }

      try {
        const result = await fileParserService.parseFile(buffer, filename);
        return { content: result.content, title: result.title ?? null };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Parsing failed';
        request.log.error({ err, filename }, 'document-upload: file parsing failed');
        reply.code(422);
        return { error: `Failed to parse file: ${message}` };
      }
    },
  );
};
