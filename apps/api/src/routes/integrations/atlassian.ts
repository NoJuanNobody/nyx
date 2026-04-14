import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { atlassianConnections, tickets, documents } from '../../db/schema.js';
import { atlassianService, AtlassianTokenExpiredError, validateJiraWebhookSignature } from '../../services/atlassian.service.js';
import { config } from '../../lib/config.js';
import type { JiraWebhookPayload } from '@nyx/shared';

// ── Atlassian Integration Routes ─────────────────────────────────

export const atlassianRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/integrations/atlassian/auth — initiate OAuth 2.0 flow
  app.get('/atlassian/auth', async (request, reply) => {
    if (!config.ATLASSIAN_CLIENT_ID || !config.ATLASSIAN_CLIENT_SECRET) {
      reply.code(500);
      return { error: 'Atlassian OAuth not configured: ATLASSIAN_CLIENT_ID and ATLASSIAN_CLIENT_SECRET required' };
    }

    if (!config.ENCRYPTION_SECRET) {
      reply.code(500);
      return { error: 'ENCRYPTION_SECRET is required for Atlassian integration' };
    }

    const userId = request.user.id;
    const { teamId } = request.query as { teamId?: string };

    if (!teamId) {
      reply.code(400);
      return { error: 'teamId query parameter is required' };
    }

    const origin = request.headers.referer
      ? new URL(request.headers.referer).origin
      : `${request.protocol}://${request.host}`;

    const redirectUri = `${origin}/api/integrations/atlassian/callback`;

    const authUrl = await atlassianService.buildAuthUrl(redirectUri, userId, teamId);
    reply.redirect(authUrl);
  });

  // GET /api/integrations/atlassian/callback — OAuth callback
  app.get('/atlassian/callback', async (request, reply) => {
    const { code, state, error: oauthError } = request.query as {
      code?: string;
      state?: string;
      error?: string;
    };

    if (oauthError) {
      reply.redirect(`/app/settings?tab=integrations&atlassian=error&message=${encodeURIComponent(oauthError)}`);
      return;
    }

    if (!code || !state) {
      reply.code(400);
      return { error: 'Missing code or state parameter' };
    }

    // Validate state and retrieve PKCE data (now async, DB-backed)
    const pkceData = await atlassianService.getPkceData(state);
    if (!pkceData) {
      reply.code(400);
      return { error: 'Invalid or expired state parameter — possible CSRF attack' };
    }

    const origin = request.headers.referer
      ? new URL(request.headers.referer).origin
      : `${request.protocol}://${request.host}`;

    const redirectUri = `${origin}/api/integrations/atlassian/callback`;

    try {
      // Exchange code for tokens
      const tokenData = await atlassianService.exchangeCodeForTokens(
        code,
        redirectUri,
        pkceData.codeVerifier,
      );

      // Get accessible cloud resources
      const resources = await atlassianService.getAccessibleResources(tokenData.access_token);

      if (resources.length === 0) {
        reply.redirect('/app/settings?tab=integrations&atlassian=error&message=No+accessible+Atlassian+sites+found');
        return;
      }

      // Use the first available site
      const site = resources[0];

      // Delete any existing connection for this user
      await db
        .delete(atlassianConnections)
        .where(eq(atlassianConnections.userId, pkceData.userId));

      // Store the new connection with encrypted tokens
      const connection = await atlassianService.storeConnection({
        userId: pkceData.userId,
        teamId: pkceData.teamId,
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        expiresIn: tokenData.expires_in,
        cloudId: site.id,
        siteUrl: site.url,
        scopes: tokenData.scope.split(' '),
      });

      // Auto-register Jira webhook for status sync
      const webhookBaseUrl = config.WEBHOOK_BASE_URL ?? `${origin}`;
      const webhookUrl = `${webhookBaseUrl}/api/integrations/jira/webhook`;
      await atlassianService.registerJiraWebhook(
        tokenData.access_token,
        site.id,
        connection.id,
        webhookUrl,
      );

      reply.redirect('/app/settings?tab=integrations&atlassian=connected');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      request.log.error({ err }, 'Atlassian OAuth callback failed');
      reply.redirect(
        `/app/settings?tab=integrations&atlassian=error&message=${encodeURIComponent(message)}`,
      );
    }
  });

  // GET /api/integrations/atlassian/status — connection status
  app.get('/atlassian/status', async (request, reply) => {
    const userId = request.user.id;
    const result = await atlassianService.getConnectionStatus(userId);
    return result;
  });

  // DELETE /api/integrations/atlassian/connection — disconnect
  app.delete('/atlassian/connection', async (request, reply) => {
    const userId = request.user.id;
    const disconnected = await atlassianService.disconnect(userId);

    if (!disconnected) {
      reply.code(404);
      return { error: 'No Atlassian connection found' };
    }

    return { ok: true };
  });

  // ── Jira Endpoints ─────────────────────────────────────────

  // GET /api/integrations/atlassian/jira/projects — list Jira projects
  app.get('/atlassian/jira/projects', async (request, reply) => {
    const userId = request.user.id;
    const tokenData = await atlassianService.getValidToken(userId);

    if (!tokenData) {
      reply.code(401);
      return { error: 'Atlassian not connected or token expired. Please re-authorize.' };
    }

    try {
      const projects = await atlassianService.listJiraProjects(
        tokenData.accessToken,
        tokenData.cloudId,
      );
      return { projects };
    } catch (err) {
      if (err instanceof AtlassianTokenExpiredError) {
        reply.code(401);
        return { error: 'atlassian_token_expired', message: err.message };
      }
      const message = err instanceof Error ? err.message : 'Unknown error';
      reply.code(502);
      return { error: message };
    }
  });

  // POST /api/integrations/atlassian/jira/issues — create Jira issue
  app.post('/atlassian/jira/issues', async (request, reply) => {
    const userId = request.user.id;
    const tokenData = await atlassianService.getValidToken(userId);

    if (!tokenData) {
      reply.code(401);
      return { error: 'Atlassian not connected or token expired. Please re-authorize.' };
    }

    const body = request.body as {
      projectKey: string;
      summary: string;
      description: string;
      issueType?: string;
      labels?: string[];
      specUrl?: string;
      priority?: string;
      assigneeAccountId?: string;
    };

    if (!body.projectKey || !body.summary || !body.description) {
      reply.code(400);
      return { error: 'projectKey, summary, and description are required' };
    }

    try {
      const issue = await atlassianService.createJiraIssue(
        tokenData.accessToken,
        tokenData.cloudId,
        {
          ...body,
          issueType: (body.issueType as 'Task' | 'Story' | 'Bug' | 'Epic') ?? 'Task',
        },
      );
      reply.code(201);
      return { issue };
    } catch (err) {
      if (err instanceof AtlassianTokenExpiredError) {
        reply.code(401);
        return { error: 'atlassian_token_expired', message: err.message };
      }
      const message = err instanceof Error ? err.message : 'Unknown error';
      reply.code(502);
      return { error: message };
    }
  });

  // ── Confluence Endpoints ───────────────────────────────────

  // GET /api/integrations/atlassian/confluence/spaces — list spaces
  app.get('/atlassian/confluence/spaces', async (request, reply) => {
    const userId = request.user.id;
    const tokenData = await atlassianService.getValidToken(userId);

    if (!tokenData) {
      reply.code(401);
      return { error: 'Atlassian not connected or token expired. Please re-authorize.' };
    }

    try {
      const spaces = await atlassianService.listConfluenceSpaces(
        tokenData.accessToken,
        tokenData.cloudId,
      );
      return { spaces };
    } catch (err) {
      if (err instanceof AtlassianTokenExpiredError) {
        reply.code(401);
        return { error: 'atlassian_token_expired', message: err.message };
      }
      const message = err instanceof Error ? err.message : 'Unknown error';
      reply.code(502);
      return { error: message };
    }
  });

  // POST /api/integrations/atlassian/confluence/export — export to Confluence
  app.post('/atlassian/confluence/export', async (request, reply) => {
    const userId = request.user.id;
    const tokenData = await atlassianService.getValidToken(userId);

    if (!tokenData) {
      reply.code(401);
      return { error: 'Atlassian not connected or token expired. Please re-authorize.' };
    }

    const body = request.body as {
      spaceId: string;
      title: string;
      content: string;
      parentPageId?: string;
      existingPageId?: string;
    };

    if (!body.spaceId || !body.title || !body.content) {
      reply.code(400);
      return { error: 'spaceId, title, and content are required' };
    }

    try {
      const page = await atlassianService.exportToConfluence(
        tokenData.accessToken,
        tokenData.cloudId,
        body,
      );
      reply.code(201);
      return { page };
    } catch (err) {
      if (err instanceof AtlassianTokenExpiredError) {
        reply.code(401);
        return { error: 'atlassian_token_expired', message: err.message };
      }
      const message = err instanceof Error ? err.message : 'Unknown error';
      reply.code(502);
      return { error: message };
    }
  });

  // POST /api/integrations/atlassian/confluence/import — import from Confluence
  app.post('/atlassian/confluence/import', async (request, reply) => {
    const userId = request.user.id;
    const tokenData = await atlassianService.getValidToken(userId);

    if (!tokenData) {
      reply.code(401);
      return { error: 'Atlassian not connected or token expired. Please re-authorize.' };
    }

    const { pageId } = request.body as { pageId: string };

    if (!pageId) {
      reply.code(400);
      return { error: 'pageId is required' };
    }

    try {
      const imported = await atlassianService.importFromConfluence(
        tokenData.accessToken,
        tokenData.cloudId,
        pageId,
      );
      return { imported };
    } catch (err) {
      if (err instanceof AtlassianTokenExpiredError) {
        reply.code(401);
        return { error: 'atlassian_token_expired', message: err.message };
      }
      const message = err instanceof Error ? err.message : 'Unknown error';
      reply.code(502);
      return { error: message };
    }
  });

  // ── Jira Webhook ───────────────────────────────────────────

  // POST /api/integrations/jira/webhook — handle Jira webhook events
  app.post('/jira/webhook', async (request, reply) => {
    // Validate webhook signature if JIRA_WEBHOOK_SECRET is configured
    const signature = request.headers['x-hub-signature'] as string | undefined;
    const rawBody = JSON.stringify(request.body);

    if (!validateJiraWebhookSignature(rawBody, signature)) {
      reply.code(401);
      return { error: 'Invalid webhook signature' };
    }

    const payload = request.body as JiraWebhookPayload;

    if (!payload?.webhookEvent || !payload?.issue) {
      reply.code(400);
      return { error: 'Invalid webhook payload' };
    }

    const issueKey = payload.issue.key;
    const statusCategory = payload.issue.fields?.status?.statusCategory?.name;

    if (payload.webhookEvent === 'jira:issue_updated' && statusCategory) {
      const nyxStatus = atlassianService.mapJiraStatusToNyx(statusCategory);

      // Map Nyx status to ticket status enum
      const ticketStatusMap: Record<string, 'open' | 'in_progress' | 'closed'> = {
        pending: 'open',
        in_progress: 'in_progress',
        completed: 'closed',
      };

      const ticketStatus = ticketStatusMap[nyxStatus] ?? 'open';

      // Update any matching tickets in Nyx
      await db
        .update(tickets)
        .set({ status: ticketStatus, updatedAt: new Date() })
        .where(eq(tickets.externalId, issueKey));
    }

    if (payload.webhookEvent === 'jira:issue_deleted') {
      // Mark ticket as closed when deleted in Jira
      await db
        .update(tickets)
        .set({ status: 'closed', updatedAt: new Date() })
        .where(eq(tickets.externalId, issueKey));
    }

    return { ok: true };
  });

  // ── Preferences ────────────────────────────────────────────

  // PUT /api/integrations/atlassian/preferences — update sync preferences
  app.put('/atlassian/preferences', async (request, reply) => {
    const userId = request.user.id;
    const preferences = request.body as Record<string, unknown>;

    const [connection] = await db
      .select()
      .from(atlassianConnections)
      .where(eq(atlassianConnections.userId, userId));

    if (!connection) {
      reply.code(404);
      return { error: 'No Atlassian connection found' };
    }

    await db
      .update(atlassianConnections)
      .set({ preferences, updatedAt: new Date() })
      .where(eq(atlassianConnections.id, connection.id));

    return { ok: true };
  });
};
