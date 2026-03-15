import type { FastifyPluginAsync } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { documents, documentTemplates } from '../db/schema.js';
import { requireRole } from '../middleware/permissions.js';
import { timelineService } from '../services/timeline.service.js';
import { auditService } from '../services/audit.service.js';

export const documentRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/documents?teamId=X&stage=Y — list documents for a team
  // viewers+ can list
  app.get('/', { preHandler: [requireRole({ minimumRole: 'viewer', source: 'request' })] }, async (request) => {
    const { teamId, includeArchived, stage } = request.query as {
      teamId?: string;
      includeArchived?: string;
      stage?: string;
    };

    if (!teamId) {
      return { error: 'teamId query parameter is required' };
    }

    const rows = await db
      .select()
      .from(documents)
      .where(eq(documents.teamId, teamId));

    let filtered = rows;

    // Filter out archived documents by default
    if (includeArchived !== 'true') {
      filtered = filtered.filter((doc) => doc.status !== 'archived');
    }

    // Filter by stage if provided
    if (stage) {
      filtered = filtered.filter((doc) => doc.stage === stage);
    }

    // Sort
    const { sort, limit } = request.query as { sort?: string; limit?: string };
    if (sort === 'name') {
      filtered.sort((a, b) => (a.title ?? '').localeCompare(b.title ?? ''));
    } else {
      // Default: recent first
      filtered.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    }

    // Limit
    if (limit) {
      const n = parseInt(limit, 10);
      if (!isNaN(n) && n > 0) filtered = filtered.slice(0, n);
    }

    return filtered;
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
    const { title, content, teamId, path, stage, templateId } = request.body as {
      title: string;
      content?: string;
      teamId: string;
      path?: string;
      stage?: 'conception' | 'definition' | 'architecture' | 'implementation' | 'execution' | null;
      templateId?: string;
    };
    const userId = request.user.id;

    if (!teamId) {
      request.log.error({ userId }, 'POST /documents — missing teamId in request body');
      reply.code(400);
      return { error: 'teamId is required to create a document' };
    }

    let docTitle = title;
    let docContent = content ?? '';
    let docStage = stage ?? null;

    // If templateId is provided, use template's content/title as defaults
    if (templateId) {
      const [template] = await db
        .select()
        .from(documentTemplates)
        .where(eq(documentTemplates.id, templateId));

      if (template) {
        if (!content) docContent = template.content;
        if (title === 'Untitled Document') docTitle = template.name;
        if (!stage) docStage = template.stage;
      } else {
        request.log.warn({ templateId, userId }, 'POST /documents — templateId not found, ignoring');
      }
    }

    try {
      const [doc] = await db
        .insert(documents)
        .values({
          title: docTitle,
          content: docContent,
          path: path ?? '/',
          stage: docStage,
          teamId,
          createdById: userId,
        })
        .returning();

      reply.code(201);
      return doc;
    } catch (err) {
      request.log.error({ err, teamId, userId }, 'POST /documents — failed to insert document');
      reply.code(500);
      return { error: 'Failed to create document. Check that the team exists and you have permission.' };
    }
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
      stage?: 'conception' | 'definition' | 'architecture' | 'implementation' | 'execution' | null;
    };

    const updates: Partial<typeof documents.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (body.title !== undefined) updates.title = body.title;
    if (body.content !== undefined) updates.content = body.content;
    if (body.path !== undefined) updates.path = body.path;
    if (body.status !== undefined) updates.status = body.status;
    if (body.stage !== undefined) updates.stage = body.stage;

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
