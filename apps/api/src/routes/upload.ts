import type { FastifyPluginAsync } from 'fastify';
import multipart from '@fastify/multipart';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { documents } from '../db/schema.js';
import { requireRole } from '../middleware/permissions.js';
import { fileParserService } from '../services/file-parser.service.js';

export const uploadRoutes: FastifyPluginAsync = async (app) => {
  // Register multipart support scoped to this plugin
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } }); // 10 MB max

  // POST /api/documents/:id/upload — upload a file and append its content to a document
  // editors+ can upload
  app.post(
    '/:id/upload',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, preHandler: [requireRole({ minimumRole: 'editor', source: 'document' })] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      // Retrieve the file from the multipart request
      const data = await request.file();

      if (!data) {
        reply.code(400);
        return { error: 'No file uploaded. Send a multipart form with a file field.' };
      }

      const buffer = await data.toBuffer();

      if (buffer.length === 0) {
        reply.code(400);
        return { error: 'Uploaded file is empty.' };
      }

      // Parse the file content
      const parsed = fileParserService.parseFile(buffer, data.mimetype, data.filename);

      // Fetch the existing document
      const [doc] = await db.select().from(documents).where(eq(documents.id, id));

      if (!doc) {
        reply.code(404);
        return { error: 'Document not found' };
      }

      // Append the parsed content to the existing document content
      const separator = doc.content ? '\n\n---\n\n' : '';
      const noteHeader = parsed.note ? `> **Note:** ${parsed.note}\n\n` : '';
      const newContent = `${doc.content ?? ''}${separator}${noteHeader}${parsed.content}`;

      const [updated] = await db
        .update(documents)
        .set({ content: newContent, updatedAt: new Date() })
        .where(eq(documents.id, id))
        .returning();

      return {
        document: updated,
        ...(parsed.note ? { note: parsed.note } : {}),
      };
    },
  );
};
