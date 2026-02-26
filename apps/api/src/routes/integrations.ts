import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { integrations } from '../db/schema.js';
import { githubService } from '../services/github.service.js';
import { jiraService } from '../services/jira.service.js';
import { requireRole } from '../middleware/permissions.js';

export const integrationRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/integrations?teamId=X — list integrations for a team
  // viewers+ can list integrations
  app.get('/', { preHandler: [requireRole({ minimumRole: 'viewer', source: 'request' })] }, async (request, reply) => {
    const { teamId } = request.query as { teamId?: string };

    if (!teamId) {
      reply.code(400);
      return { error: 'teamId query parameter is required' };
    }

    const rows = await db
      .select()
      .from(integrations)
      .where(eq(integrations.teamId, teamId));

    return rows;
  });

  // POST /api/integrations — create an integration
  // admins+ can create integrations
  app.post('/', { preHandler: [requireRole({ minimumRole: 'admin', source: 'request' })] }, async (request, reply) => {
    const { teamId, type, config } = request.body as {
      teamId: string;
      type: 'github' | 'jira' | 'confluence';
      config: Record<string, unknown>;
    };

    const [integration] = await db
      .insert(integrations)
      .values({ teamId, type, config })
      .returning();

    reply.code(201);
    return integration;
  });

  // DELETE /api/integrations/:id — remove an integration
  // admins+ can delete integrations
  app.delete('/:id', { preHandler: [requireRole({ minimumRole: 'admin', source: 'integration' })] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const [deleted] = await db
      .delete(integrations)
      .where(eq(integrations.id, id))
      .returning();

    if (!deleted) {
      reply.code(404);
      return { error: 'Integration not found' };
    }

    return deleted;
  });

  // POST /api/integrations/:id/test — test the integration connection
  // admins+ can test integrations
  app.post('/:id/test', { preHandler: [requireRole({ minimumRole: 'admin', source: 'integration' })] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const [integration] = await db
      .select()
      .from(integrations)
      .where(eq(integrations.id, id));

    if (!integration) {
      reply.code(404);
      return { error: 'Integration not found' };
    }

    const config = integration.config as Record<string, unknown>;

    try {
      if (integration.type === 'github') {
        const repos = await githubService.listRepos(config.accessToken as string);
        return { ok: true, message: `Connected. Found ${repos.length} repos.` };
      }

      if (integration.type === 'jira') {
        const projects = await jiraService.listProjects(
          config.baseUrl as string,
          config.email as string,
          config.apiToken as string,
        );
        return { ok: true, message: `Connected. Found ${projects.length} projects.` };
      }

      return { ok: false, message: `Test not supported for type: ${integration.type}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      reply.code(502);
      return { ok: false, message };
    }
  });
};
