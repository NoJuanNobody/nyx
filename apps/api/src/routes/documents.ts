import type { FastifyPluginAsync } from 'fastify';
import { eq, and, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { documents, documentTemplates, marketplaceListings } from '../db/schema.js';
import { requireRole } from '../middleware/permissions.js';
import { timelineService } from '../services/timeline.service.js';
import { auditService } from '../services/audit.service.js';
import { gatekeeperService } from '../services/gatekeeper.service.js';
import { embeddingPipelineService } from '../services/embedding-pipeline.service.js';
import { contextMatchingService } from '../services/context-matching.service.js';

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

  // GET /api/documents/:id/related — find related specs via AI context matching
  // viewers+ can read
  app.get('/:id/related', { preHandler: [requireRole({ minimumRole: 'viewer', source: 'document' })] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const [doc] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, id));

    if (!doc) {
      reply.code(404);
      return { error: 'Document not found' };
    }

    try {
      const result = await contextMatchingService.findRelatedSpecs(
        doc.content ?? '',
        doc.teamId,
      );

      const related = result.matches.map((m) => ({
        id: m.documentId,
        title: m.title,
        score: m.relevance,
        snippet: m.summary,
        relevance: m.relevance,
        relationship: m.relationship,
      }));

      return { related, signals: result.signals };
    } catch (err) {
      request.log.error({ err, docId: id }, 'GET /documents/:id/related — context matching failed');
      reply.code(500);
      return { error: 'Failed to find related specs. AI service may be unavailable.' };
    }
  });

  // POST /api/documents — create a document
  // editors+ can create
  app.post('/', { preHandler: [requireRole({ minimumRole: 'editor', source: 'request' })] }, async (request, reply) => {
    const { title, content, teamId, path, stage, templateId } = request.body as {
      title: string;
      content?: string;
      teamId: string;
      path?: string;
      stage?: string | null;
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

      // Fire-and-forget: index document for vector search
      setImmediate(async () => {
        try {
          await embeddingPipelineService.indexDocument(doc.id, docContent, teamId, 1);
        } catch (e) {
          request.log.warn({ err: e, docId: doc.id }, 'embedding indexing failed');
        }
      });

      reply.code(201);
      return doc;
    } catch (err) {
      request.log.error({ err, teamId, userId }, 'POST /documents — failed to insert document');
      reply.code(500);
      return { error: 'Failed to create document. Check that the team exists and you have permission.' };
    }
  });

  // POST /api/documents/from-template — create a document from a marketplace listing
  // editors+ can create
  app.post('/from-template', { preHandler: [requireRole({ minimumRole: 'editor', source: 'request' })] }, async (request, reply) => {
    const { listingId, teamId, path } = request.body as {
      listingId: string;
      teamId: string;
      path?: string;
    };
    const userId = request.user.id;

    if (!teamId) {
      reply.code(400);
      return { error: 'teamId is required' };
    }

    if (!listingId) {
      reply.code(400);
      return { error: 'listingId is required' };
    }

    // Fetch the marketplace listing
    const [listing] = await db
      .select()
      .from(marketplaceListings)
      .where(and(eq(marketplaceListings.id, listingId), eq(marketplaceListings.published, true)));

    if (!listing) {
      reply.code(404);
      return { error: 'Marketplace listing not found' };
    }

    try {
      // Create a document pre-filled with the listing content
      const [doc] = await db
        .insert(documents)
        .values({
          title: listing.title,
          content: listing.content,
          path: path ?? '/',
          stage: listing.stage,
          teamId,
          createdById: userId,
        })
        .returning();

      // Increment download count on the listing (fire-and-forget)
      setImmediate(async () => {
        try {
          await db
            .update(marketplaceListings)
            .set({ downloadCount: sql`${marketplaceListings.downloadCount} + 1` })
            .where(eq(marketplaceListings.id, listingId));
        } catch {}
      });

      reply.code(201);
      return doc;
    } catch (err) {
      request.log.error({ err, teamId, userId, listingId }, 'POST /documents/from-template — failed');
      reply.code(500);
      return { error: 'Failed to create document from template.' };
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
      stage?: string | null;
    };

    // If stage is changing, enforce gatekeeper rules
    if ('stage' in body && body.stage !== undefined) {
      // Fetch the current document to evaluate the gate
      const [current] = await db.select().from(documents).where(eq(documents.id, id));
      if (!current) {
        reply.code(404);
        return { error: 'Document not found' };
      }

      // Use the content that will be saved (body.content if provided, otherwise current)
      const effectiveContent = body.content !== undefined ? body.content : current.content;

      const gateResult = gatekeeperService.evaluateGate(
        { content: effectiveContent, stage: current.stage },
        body.stage as string,
      );

      if (!gateResult.passed) {
        reply.code(422);
        return {
          error: 'Stage transition blocked by gatekeeper',
          checks: gateResult.checks.filter((c) => !c.passed),
        };
      }
    }

    const updates: Partial<typeof documents.$inferInsert> = {
      updatedAt: new Date(),
    };
    if ('title' in body) updates.title = body.title;
    if ('content' in body) updates.content = body.content;
    if ('path' in body) updates.path = body.path;
    if ('status' in body) updates.status = body.status;
    if ('stage' in body) updates.stage = body.stage;

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

    // Fire-and-forget: re-index document embeddings when content changes
    if ('content' in body) {
      setImmediate(async () => {
        try {
          await embeddingPipelineService.indexDocument(
            id,
            doc.content ?? '',
            doc.teamId,
            Math.floor(doc.updatedAt.getTime() / 1000),
          );
        } catch (e) {
          request.log.warn({ err: e, docId: id }, 'embedding re-indexing failed');
        }
      });
    }

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

    // Fire-and-forget: remove embedding chunks for archived document
    setImmediate(async () => {
      try {
        await embeddingPipelineService.removeDocumentChunks(id);
      } catch (e) {
        request.log.warn({ err: e, docId: id }, 'embedding chunk removal failed');
      }
    });

    reply.code(200);
    return doc;
  });
};
