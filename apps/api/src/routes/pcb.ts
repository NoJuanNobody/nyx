import type { FastifyPluginAsync } from 'fastify';
import multipart from '@fastify/multipart';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { pcbAttachments } from '../db/schema.js';
import { requireRole } from '../middleware/permissions.js';
import { pcbParserService } from '../services/pcb-parser.service.js';

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

export const pcbRoutes: FastifyPluginAsync = async (app) => {
  await app.register(multipart, {
    limits: { fileSize: MAX_FILE_SIZE },
  });

  // POST /api/pcb/upload — upload one or more PCB files attached to a document
  // editors+ can upload
  app.post(
    '/upload',
    { preHandler: [requireRole({ minimumRole: 'editor', source: 'request' })] },
    async (request, reply) => {
      const { documentId } = request.query as { documentId?: string };
      if (!documentId) {
        reply.code(400);
        return { error: 'documentId query parameter is required' };
      }

      const parts = request.files();
      const uploaded: (typeof pcbAttachments.$inferSelect)[] = [];
      const errors: string[] = [];

      for await (const part of parts) {
        const buffer = await part.toBuffer();
        const validation = pcbParserService.validateAndParse(part.filename, part.mimetype, buffer);

        if (!validation.valid || !validation.metadata) {
          errors.push(`${part.filename}: ${validation.error}`);
          continue;
        }

        const { metadata } = validation;

        try {
          const [row] = await db
            .insert(pcbAttachments)
            .values({
              documentId,
              filename: part.filename,
              fileType: metadata.fileType,
              mimeType: part.mimetype,
              fileData: buffer.toString('base64'),
              fileSize: buffer.length,
              layerName: metadata.layerName ?? null,
              layerType: metadata.layerType ?? null,
              metadata: {
                bom: metadata.bom ?? [],
                componentCount: metadata.componentCount ?? 0,
                boardWidthMm: metadata.boardWidthMm,
                boardHeightMm: metadata.boardHeightMm,
              },
            })
            .returning();

          uploaded.push(row);
        } catch (err) {
          request.log.error({ err, filename: part.filename }, 'PCB upload — DB insert failed');
          errors.push(`${part.filename}: Failed to save to database`);
        }
      }

      if (uploaded.length === 0 && errors.length > 0) {
        reply.code(400);
        return { error: errors.join('; ') };
      }

      reply.code(201);
      return {
        uploaded: uploaded.map(safeAttachment),
        errors: errors.length > 0 ? errors : undefined,
      };
    },
  );

  // GET /api/pcb/document/:documentId — list all PCB attachments for a document
  // viewers+ can read
  app.get(
    '/document/:documentId',
    { preHandler: [requireRole({ minimumRole: 'viewer', source: 'document' })] },
    async (request, reply) => {
      const { documentId } = request.params as { documentId: string };

      const rows = await db
        .select()
        .from(pcbAttachments)
        .where(eq(pcbAttachments.documentId, documentId));

      return rows.map(safeAttachment);
    },
  );

  // GET /api/pcb/:id/raw — download the raw file content (base64 decoded)
  // viewers+ can download
  app.get(
    '/:id/raw',
    { preHandler: [requireRole({ minimumRole: 'viewer', source: 'request' })] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const [row] = await db
        .select()
        .from(pcbAttachments)
        .where(eq(pcbAttachments.id, id));

      if (!row) {
        reply.code(404);
        return { error: 'Attachment not found' };
      }

      const buffer = Buffer.from(row.fileData, 'base64');
      reply
        .header('Content-Type', row.mimeType || 'application/octet-stream')
        .header('Content-Disposition', `attachment; filename="${row.filename}"`)
        .send(buffer);
    },
  );

  // DELETE /api/pcb/:id — delete a PCB attachment
  // editors+ can delete
  app.delete(
    '/:id',
    { preHandler: [requireRole({ minimumRole: 'editor', source: 'request' })] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const [row] = await db
        .delete(pcbAttachments)
        .where(eq(pcbAttachments.id, id))
        .returning();

      if (!row) {
        reply.code(404);
        return { error: 'Attachment not found' };
      }

      return { success: true };
    },
  );
};

/** Return attachment metadata without the raw base64 file data to keep responses lean. */
function safeAttachment(row: typeof pcbAttachments.$inferSelect) {
  const { fileData: _fileData, ...rest } = row;
  return rest;
}
