import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { lifecycles, lifecycleStages } from '../db/schema.js';
import { gatekeeperService, type GateRule } from '../services/gatekeeper.service.js';

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

  // PUT /api/lifecycle-stages/:stageId/gate-rules — replace gate rules for a stage
  // Requires admin role (team admins can configure gate rules for their lifecycle).
  app.put('/stages/:stageId/gate-rules', async (request, reply) => {
    const { stageId } = request.params as { stageId: string };
    const { rules } = request.body as { rules?: GateRule[] };

    if (!Array.isArray(rules)) {
      reply.code(400);
      return { error: '`rules` must be an array' };
    }

    const [stage] = await db
      .select()
      .from(lifecycleStages)
      .where(eq(lifecycleStages.id, stageId));

    if (!stage) {
      reply.code(404);
      return { error: 'Stage not found' };
    }

    await gatekeeperService.setGateRules(stageId, rules);

    return { ...stage, gateRules: rules };
  });

  // GET /api/lifecycle-stages/:stageId/gate-rules — retrieve gate rules for a stage
  app.get('/stages/:stageId/gate-rules', async (request, reply) => {
    const { stageId } = request.params as { stageId: string };

    const [stage] = await db
      .select()
      .from(lifecycleStages)
      .where(eq(lifecycleStages.id, stageId));

    if (!stage) {
      reply.code(404);
      return { error: 'Stage not found' };
    }

    return { stageId: stage.id, slug: stage.slug, label: stage.label, rules: stage.gateRules ?? [] };
  });
};
