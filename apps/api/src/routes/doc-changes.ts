import type { FastifyPluginAsync } from 'fastify';
import { eq, and, gt, desc, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { documents } from '../db/schema.js';
import { requireRole } from '../middleware/permissions.js';

export const docChangesRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/documents/changes?teamId=X&since=<ISO-timestamp>&limit=N
  // Returns documents updated after the given timestamp
  app.get(
    '/changes',
    { preHandler: [requireRole({ minimumRole: 'viewer', source: 'request' })] },
    async (request, reply) => {
      const { teamId, since, limit } = request.query as {
        teamId?: string;
        since?: string;
        limit?: string;
      };

      if (!teamId) {
        return reply.status(400).send({ error: 'teamId query parameter is required' });
      }

      if (!since) {
        return reply.status(400).send({ error: 'since query parameter is required (ISO-8601 timestamp)' });
      }

      const sinceDate = new Date(since);
      if (isNaN(sinceDate.getTime())) {
        return reply.status(400).send({ error: 'since must be a valid ISO-8601 timestamp' });
      }

      const maxLimit = Math.min(parseInt(limit || '50', 10) || 50, 200);

      const rows = await db
        .select({
          id: documents.id,
          title: documents.title,
          updatedAt: documents.updatedAt,
          stage: documents.stage,
        })
        .from(documents)
        .where(
          and(
            eq(documents.teamId, teamId),
            gt(documents.updatedAt, sinceDate),
            isNull(documents.deletedAt),
          ),
        )
        .orderBy(desc(documents.updatedAt))
        .limit(maxLimit);

      const until =
        rows.length > 0
          ? rows[0].updatedAt.toISOString()
          : sinceDate.toISOString();

      return {
        changes: rows.map((r) => ({
          id: r.id,
          title: r.title,
          updatedAt: r.updatedAt.toISOString(),
          stage: r.stage,
        })),
        since: sinceDate.toISOString(),
        until,
      };
    },
  );
};
