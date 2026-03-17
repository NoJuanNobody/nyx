import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { lifecycles, lifecycleStages } from '../db/schema.js';

export const lifecycleRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/lifecycles — list all lifecycles with their stages
  app.get('/', async () => {
    const rows = await db
      .select()
      .from(lifecycles)
      .orderBy(lifecycles.sortOrder);

    const stages = await db
      .select()
      .from(lifecycleStages)
      .orderBy(lifecycleStages.sortOrder);

    // Group stages by lifecycleId
    const stagesByLifecycle = new Map<string, typeof stages>();
    for (const stage of stages) {
      const arr = stagesByLifecycle.get(stage.lifecycleId) ?? [];
      arr.push(stage);
      stagesByLifecycle.set(stage.lifecycleId, arr);
    }

    return rows.map((lc) => ({
      ...lc,
      stages: stagesByLifecycle.get(lc.id) ?? [],
    }));
  });

  // GET /api/lifecycles/:slug — single lifecycle with stages
  app.get('/:slug', async (request, reply) => {
    const { slug } = request.params as { slug: string };

    const [lc] = await db
      .select()
      .from(lifecycles)
      .where(eq(lifecycles.slug, slug));

    if (!lc) {
      reply.code(404);
      return { error: 'Lifecycle not found' };
    }

    const stages = await db
      .select()
      .from(lifecycleStages)
      .where(eq(lifecycleStages.lifecycleId, lc.id))
      .orderBy(lifecycleStages.sortOrder);

    return { ...lc, stages };
  });
};
