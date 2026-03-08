import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { documents } from '../db/schema.js';
import { requireRole } from '../middleware/permissions.js';
import { timelineService } from '../services/timeline.service.js';
import { auditService } from '../services/audit.service.js';

export const documentRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/documents?teamId=X — list documents for a team
  // viewers+ can list
  app.get('/', { preHandler: [requireRole({ minimumRole: 'viewer', source: 'request' })] }, async (request) => {
    const { teamId, includeArchived } = request.query as { teamId?: string; includeArchived?: string };

    if (!teamId) {
      return { error: 'teamId query parameter is required' };
    }

    const rows = await db
      .select()
      .from(documents)
      .where(eq(documents.teamId, teamId));

    // Filter out archived documents by default
    if (includeArchived === 'true') return rows;
    return rows.filter((doc) => doc.status !== 'archived');
  });

  // GET /api/documents/:id — get a single document
  // viewers+ can read
  app.get('/:id', { preHandler: [requireRole({ minimumRole: 'viewer', source: 'document' })] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const [doc] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, id));

    if (!doc) {
      reply.code(404);
      return { error: 'Document not found' };
    }

    return doc;
  });

  // POST /api/documents — create a document
  // editors+ can create
  app.post('/', { preHandler: [requireRole({ minimumRole: 'editor', source: 'request' })] }, async (request, reply) => {
    const { title, content, teamId, path } = request.body as {
      title: string;
      content?: string;
      teamId: string;
      path?: string;
    };
    const userId = request.user.id;

    const [doc] = await db
      .insert(documents)
      .values({
        title,
        content: content ?? '',
        path: path ?? '/',
        teamId,
        createdById: userId,
      })
      .returning();

    reply.code(201);
    return doc;
  });

  // PUT /api/documents/:id — update a document
  // editors+ can update
  app.put('/:id', { preHandler: [requireRole({ minimumRole: 'editor', source: 'document' })] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      title?: string;
      content?: string;
      path?: string;
      status?: 'draft' | 'published' | 'archived';
    };

    const updates: Partial<typeof documents.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (body.title !== undefined) updates.title = body.title;
    if (body.content !== undefined) updates.content = body.content;
    if (body.path !== undefined) updates.path = body.path;
    if (body.status !== undefined) updates.status = body.status;

    const [doc] = await db
      .update(documents)
      .set(updates)
      .where(eq(documents.id, id))
      .returning();

    if (!doc) {
      reply.code(404);
      return { error: 'Document not found' };
    }

    // Fire-and-forget: record timeline event
    setImmediate(async () => {
      try {
        await timelineService.create({
          documentId: id,
          type: 'document_updated',
          payload: { fields: Object.keys(body).filter(k => (body as Record<string, unknown>)[k] !== undefined) },
          actorId: request.user.id,
        });
        await auditService.recordEvent({
          teamId: doc.teamId,
          eventType: 'doc_edit',
          actorId: request.user.id,
          documentId: id,
          metadata: { fields: Object.keys(body).filter(k => (body as Record<string, unknown>)[k] !== undefined) },
        });
      } catch {}
    });

    return doc;
  });

  // DELETE /api/documents/:id — soft delete (set status to 'archived')
  // admins+ can delete
  app.delete('/:id', { preHandler: [requireRole({ minimumRole: 'admin', source: 'document' })] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const [doc] = await db
      .update(documents)
      .set({ status: 'archived', updatedAt: new Date() })
      .where(eq(documents.id, id))
      .returning();

    if (!doc) {
      reply.code(404);
      return { error: 'Document not found' };
    }

    reply.code(200);
    return doc;
  });
};
