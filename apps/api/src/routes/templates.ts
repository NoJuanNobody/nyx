import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { documentTemplates } from '../db/schema.js';

export const templateRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/templates?stage=X — list all templates, optional stage filter
  app.get('/', async (request) => {
    const { stage } = request.query as { stage?: string };

    const rows = await db
      .select()
      .from(documentTemplates)
      .orderBy(documentTemplates.sortOrder);

    // Deduplicate by (stage, name) — safety net for databases with pre-existing duplicates
    const seen = new Set<string>();
    const deduped = rows.filter((t) => {
      const key = `${t.stage}:${t.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (stage) {
      return deduped.filter((t) => t.stage === stage);
    }

    return deduped;
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
};
