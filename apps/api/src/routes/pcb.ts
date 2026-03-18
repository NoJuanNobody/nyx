import type { FastifyPluginAsync } from 'fastify';
import multipart from '@fastify/multipart';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { documents } from '../db/schema.js';
import { requireRole } from '../middleware/permissions.js';
import { pcbParserService } from '../services/pcb-parser.service.js';

// In-memory PCB metadata store (keyed by documentId)
const pcbStore = new Map<string, unknown[]>();

export const pcbRoutes: FastifyPluginAsync = async (app) => {
  // Register multipart support scoped to this plugin
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } }); // 50 MB max for PCB files

  // POST /api/documents/:id/pcb — upload a PCB file and store parsed metadata
  app.post(
    '/:id/pcb',
    { preHandler: [requireRole({ minimumRole: 'editor', source: 'document' })] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const data = await request.file();

      if (!data) {
        reply.code(400);
        return { error: 'No file uploaded. Send a multipart form with a PCB file field.' };
      }

      const buffer = await data.toBuffer();

      if (buffer.length === 0) {
        reply.code(400);
        return { error: 'Uploaded file is empty.' };
      }

      const fileName = data.filename;
      const metadata = pcbParserService.parsePCBFile(buffer, fileName);

      if (metadata.format === 'unknown') {
        reply.code(400);
        return {
          error: `Unsupported PCB file format. Supported formats: .kicad_pcb, .gbr, .gbl, .gtl, .gbs, .gts, .gbo, .gto`,
        };
      }

      // Extract BOM if applicable
      const bom = pcbParserService.extractBOM(buffer, fileName);

      // Fetch the existing document
      const [doc] = await db.select().from(documents).where(eq(documents.id, id));

      if (!doc) {
        reply.code(404);
        return { error: 'Document not found' };
      }

      const attachment = {
        uploadedAt: new Date().toISOString(),
        fileName,
        metadata,
        ...(bom.length > 0 ? { bom } : {}),
      };

      // Store in memory (will be replaced by a proper DB column in a future migration)
      const existing = pcbStore.get(id) ?? [];
      existing.push(attachment);
      pcbStore.set(id, existing);

      return {
        document: { id: doc.id, title: doc.title },
        pcb: attachment,
      };
    },
  );

  // GET /api/documents/:id/pcb — retrieve stored PCB metadata for a document
  app.get(
    '/:id/pcb',
    { preHandler: [requireRole({ minimumRole: 'viewer', source: 'document' })] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const [doc] = await db.select().from(documents).where(eq(documents.id, id));

      if (!doc) {
        reply.code(404);
        return { error: 'Document not found' };
      }

      const pcbAttachments = pcbStore.get(id) ?? [];

      if (pcbAttachments.length === 0) {
        reply.code(404);
        return { error: 'No PCB metadata found for this document' };
      }

      return { documentId: id, pcbAttachments };
    },
  );
};
