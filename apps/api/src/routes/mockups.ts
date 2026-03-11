import type { FastifyPluginAsync } from 'fastify';
import { requireRole } from '../middleware/permissions.js';
import { generateMockupHTML, renderToScreenshot, generateAndAttach } from '../services/mockup.service.js';
import { githubService } from '../services/github.service.js';
import { jiraService } from '../services/jira.service.js';
import { db } from '../db/index.js';
import { eq } from 'drizzle-orm';
import { integrations } from '../db/schema.js';

// Puppeteer cluster reference — set from app.ts on startup
let _cluster: import('puppeteer-cluster').Cluster | null = null;

export function setMockupCluster(cluster: import('puppeteer-cluster').Cluster) {
  _cluster = cluster;
}

export function getMockupCluster() {
  return _cluster;
}

export const mockupRoutes: FastifyPluginAsync = async (app) => {
  // POST /api/mockups/generate — Generate a mockup from description
  app.post('/generate', {
    preHandler: [requireRole({ minimumRole: 'editor', source: 'request' })],
  }, async (request, reply) => {
    const { description } = request.body as { description: string };

    if (!description?.trim()) {
      reply.code(400);
      return { error: 'description is required' };
    }

    if (!_cluster) {
      reply.code(503);
      return { error: 'Mockup rendering service is not available' };
    }

    try {
      const { html, screenshot } = await generateAndAttach(description, _cluster);
      const base64 = screenshot.toString('base64');
      return {
        html,
        screenshot: `data:image/png;base64,${base64}`,
        mimeType: 'image/png',
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Mockup generation failed';
      reply.code(500);
      return { error: message };
    }
  });

  // POST /api/mockups/attach — Generate and attach to GitHub Issue or Jira ticket
  app.post('/attach', {
    preHandler: [requireRole({ minimumRole: 'editor', source: 'request' })],
  }, async (request, reply) => {
    const { description, provider, issueId, teamId } = request.body as {
      description: string;
      provider: 'github' | 'jira';
      issueId: string;
      teamId: string;
    };

    if (!description?.trim() || !provider || !issueId || !teamId) {
      reply.code(400);
      return { error: 'description, provider, issueId, and teamId are required' };
    }

    if (!_cluster) {
      reply.code(503);
      return { error: 'Mockup rendering service is not available' };
    }

    // Find integration for this team
    const teamIntegration = await db
      .select()
      .from(integrations)
      .where(eq(integrations.teamId, teamId))
      .then((rows) => rows.find((r) => r.type === provider));

    if (!teamIntegration) {
      reply.code(400);
      return { error: `No ${provider} integration found for this team` };
    }

    try {
      const { html, screenshot } = await generateAndAttach(description, _cluster);

      if (provider === 'github') {
        const config = teamIntegration.config as { accessToken: string; selectedRepos?: Array<{ owner: string; name: string }> };
        const repo = config.selectedRepos?.[0];
        if (!repo) {
          reply.code(400);
          return { error: 'No GitHub repository configured' };
        }
        await githubService.attachImageToIssue(
          config.accessToken,
          repo.owner,
          repo.name,
          parseInt(issueId, 10),
          screenshot,
          'mockup.png',
        );
      } else if (provider === 'jira') {
        const config = teamIntegration.config as { baseUrl: string; email: string; apiToken: string };
        await jiraService.attachFileToIssue(
          config.baseUrl,
          config.email,
          config.apiToken,
          issueId,
          screenshot,
          'mockup.png',
        );
      }

      return {
        success: true,
        html,
        provider,
        issueId,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to generate and attach mockup';
      reply.code(500);
      return { error: message };
    }
  });
};
