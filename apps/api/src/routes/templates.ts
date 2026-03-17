import type { FastifyPluginAsync } from 'fastify';
import { eq, isNull, or } from 'drizzle-orm';
import { db } from '../db/index.js';
import { documentTemplates } from '../db/schema.js';

export const templateRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/templates?stage=X&teamId=Y&lifecycleId=Z — list templates, optional filters
  app.get('/', async (request) => {
    const { stage, teamId, lifecycleId } = request.query as { stage?: string; teamId?: string; lifecycleId?: string };

    let rows;
    if (teamId) {
      // Return both global templates (teamId is null) and team-specific templates
      rows = await db
        .select()
        .from(documentTemplates)
        .where(or(isNull(documentTemplates.teamId), eq(documentTemplates.teamId, teamId)))
        .orderBy(documentTemplates.sortOrder);
    } else {
      // Return only global templates
      rows = await db
        .select()
        .from(documentTemplates)
        .where(isNull(documentTemplates.teamId))
        .orderBy(documentTemplates.sortOrder);
    }

    // Deduplicate by (stage, name) — safety net for databases with pre-existing duplicates
    const seen = new Set<string>();
    const deduped = rows.filter((t) => {
      const key = `${t.stage}:${t.name}:${t.teamId ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    let filtered = deduped;
    if (stage) {
      filtered = filtered.filter((t) => t.stage === stage);
    }
    if (lifecycleId) {
      filtered = filtered.filter((t) => (t as any).lifecycleId === lifecycleId || !(t as any).lifecycleId);
    }

    return filtered;
  });

  // GET /api/templates/:id — single template
  app.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const [template] = await db
      .select()
      .from(documentTemplates)
      .where(eq(documentTemplates.id, id));

    if (!template) {
      reply.code(404);
      return { error: 'Template not found' };
    }

    return template;
  });

  // POST /api/templates — create a custom template
  app.post('/', async (request, reply) => {
    const { name, description, content, stage, teamId } = request.body as {
      name: string;
      description: string;
      content: string;
      stage: string;
      teamId: string;
    };

    if (!name || !description || !content || !stage || !teamId) {
      reply.code(400);
      return { error: 'name, description, content, stage, and teamId are required' };
    }

    const [template] = await db
      .insert(documentTemplates)
      .values({
        name,
        description,
        content,
        stage: stage as any,
        teamId,
        createdById: request.user.id,
        sortOrder: 0,
      })
      .returning();

    reply.code(201);
    return template;
  });

  // PUT /api/templates/:id — update a custom template
  app.put('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const updates = request.body as { name?: string; description?: string; content?: string; stage?: string };

    // Verify template exists and is custom (has teamId)
    const [existing] = await db.select().from(documentTemplates).where(eq(documentTemplates.id, id));
    if (!existing) {
      reply.code(404);
      return { error: 'Template not found' };
    }
    if (!existing.teamId) {
      reply.code(403);
      return { error: 'Cannot modify built-in templates' };
    }

    const setValues: Record<string, unknown> = {};
    if (updates.name) setValues.name = updates.name;
    if (updates.description) setValues.description = updates.description;
    if (updates.content) setValues.content = updates.content;
    if (updates.stage) setValues.stage = updates.stage;

    const [updated] = await db
      .update(documentTemplates)
      .set(setValues)
      .where(eq(documentTemplates.id, id))
      .returning();

    return updated;
  });

  // DELETE /api/templates/:id — delete a custom template
  app.delete('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const [existing] = await db.select().from(documentTemplates).where(eq(documentTemplates.id, id));
    if (!existing) {
      reply.code(404);
      return { error: 'Template not found' };
    }
    if (!existing.teamId) {
      reply.code(403);
      return { error: 'Cannot delete built-in templates' };
    }

    await db.delete(documentTemplates).where(eq(documentTemplates.id, id));
    return { deleted: true };
  });
};
