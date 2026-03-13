import type { FastifyPluginAsync } from 'fastify';
import { eq, and, inArray } from 'drizzle-orm';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { db } from '../db/index.js';
import { integrations, documents, timelineEvents } from '../db/schema.js';
import { githubService, GitHubTokenExpiredError } from '../services/github.service.js';
import { jiraService } from '../services/jira.service.js';
import { requireRole } from '../middleware/permissions.js';
import { config } from '../lib/config.js';

// Simple state signing for OAuth CSRF protection
const STATE_SECRET = config.CLERK_SECRET_KEY ?? randomBytes(32).toString('hex');

function signState(payload: string): string {
  const sig = createHmac('sha256', STATE_SECRET).update(payload).digest('hex');
  return `${Buffer.from(payload).toString('base64url')}.${sig}`;
}

function verifyState(signed: string): string | null {
  const dotIdx = signed.lastIndexOf('.');
  if (dotIdx === -1) return null;
  const b64 = signed.slice(0, dotIdx);
  const sig = signed.slice(dotIdx + 1);
  const payload = Buffer.from(b64, 'base64url').toString();
  const expected = createHmac('sha256', STATE_SECRET).update(payload).digest('hex');
  if (!timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return null;
  return payload;
}

export const integrationRoutes: FastifyPluginAsync = async (app) => {
  // ── GitHub OAuth flow ──────────────────────────────────────────────

  // GET /api/integrations/github/connect — initiate GitHub OAuth
  app.get('/github/connect', async (request, reply) => {
    const { teamId } = request.query as { teamId?: string };

    if (!teamId) {
      reply.code(400);
      return { error: 'teamId query parameter is required' };
    }

    if (!config.GITHUB_CLIENT_ID || !config.GITHUB_CLIENT_SECRET) {
      reply.code(500);
      return { error: 'GitHub OAuth not configured: GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET required' };
    }

    const statePayload = JSON.stringify({ teamId, nonce: randomBytes(16).toString('hex') });
    const state = signState(statePayload);

    reply.setCookie('github_oauth_state', state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.NODE_ENV === 'production',
      maxAge: 600,
      path: '/',
    });

    // Derive the real frontend origin (Vite proxy changes the Host header)
    const origin = request.headers.referer
      ? new URL(request.headers.referer).origin
      : `${request.protocol}://${request.host}`;

    const params = new URLSearchParams({
      client_id: config.GITHUB_CLIENT_ID,
      redirect_uri: `${origin}/api/integrations/github/callback`,
      scope: 'repo read:org admin:repo_hook',
      state,
    });

    reply.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
  });

  // GET /api/integrations/github/callback — handle GitHub OAuth callback
  app.get('/github/callback', async (request, reply) => {
    const { code, state } = request.query as { code?: string; state?: string };

    if (!code || !state) {
      reply.code(400);
      return { error: 'Missing code or state parameter' };
    }

    // Verify state against cookie
    const cookieState = request.cookies.github_oauth_state;
    if (!cookieState || cookieState !== state) {
      reply.code(403);
      return { error: 'Invalid OAuth state — possible CSRF attack' };
    }

    const payload = verifyState(state);
    if (!payload) {
      reply.code(403);
      return { error: 'State signature verification failed' };
    }

    const { teamId } = JSON.parse(payload) as { teamId: string };

    // Clear the state cookie
    reply.clearCookie('github_oauth_state', { path: '/' });

    // Exchange code for token
    const tokenData = await githubService.exchangeCodeForToken(
      config.GITHUB_CLIENT_ID!,
      config.GITHUB_CLIENT_SECRET!,
      code,
    );

    // Get GitHub user info
    const ghUser = await githubService.getAuthenticatedUser(tokenData.access_token);

    // Upsert the integration (replace existing GitHub integration for this team)
    const [existing] = await db
      .select()
      .from(integrations)
      .where(and(eq(integrations.teamId, teamId), eq(integrations.type, 'github')));

    if (existing) {
      await db
        .update(integrations)
        .set({
          config: {
            accessToken: tokenData.access_token,
            githubUsername: ghUser.login,
            avatarUrl: ghUser.avatar_url,
            scopes: tokenData.scope.split(',').map((s: string) => s.trim()),
          },
          updatedAt: new Date(),
        })
        .where(eq(integrations.id, existing.id));
    } else {
      await db.insert(integrations).values({
        teamId,
        type: 'github',
        config: {
          accessToken: tokenData.access_token,
          githubUsername: ghUser.login,
          avatarUrl: ghUser.avatar_url,
          scopes: tokenData.scope.split(',').map((s: string) => s.trim()),
        },
      });
    }

    // Redirect back to settings
    reply.redirect('/settings?tab=integrations&github=connected');
  });

  // GET /api/integrations/:id/github/repos — list repos for a connected GitHub integration
  app.get('/:id/github/repos', { preHandler: [requireRole({ minimumRole: 'viewer', source: 'integration' })] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const [integration] = await db
      .select()
      .from(integrations)
      .where(eq(integrations.id, id));

    if (!integration || integration.type !== 'github') {
      reply.code(404);
      return { error: 'GitHub integration not found' };
    }

    const cfg = integration.config as { accessToken?: string };

    if (!cfg.accessToken) {
      reply.code(400);
      return { error: 'GitHub access token is missing. Please reconnect the integration.' };
    }

    try {
      const repos = await githubService.listRepos(cfg.accessToken);
      return { repos };
    } catch (err) {
      if (err instanceof GitHubTokenExpiredError) {
        reply.code(401);
        return { error: 'github_token_expired', message: err.message };
      }
      const message = err instanceof Error ? err.message : 'Unknown error';
      reply.code(502);
      return { error: message };
    }
  });

  // PUT /api/integrations/:id/github/repos — save selected repos + auto-register webhooks
  app.put('/:id/github/repos', { preHandler: [requireRole({ minimumRole: 'admin', source: 'integration' })] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { repos } = request.body as { repos: Array<{ owner: string; name: string; fullName: string }> };

    const [integration] = await db
      .select()
      .from(integrations)
      .where(eq(integrations.id, id));

    if (!integration || integration.type !== 'github') {
      reply.code(404);
      return { error: 'GitHub integration not found' };
    }

    const cfg = integration.config as Record<string, unknown>;
    const accessToken = cfg.accessToken as string;
    const currentRepos = (cfg.selectedRepos as Array<{ owner: string; name: string; fullName: string }>) ?? [];
    const webhookIds = (cfg.webhookIds as Record<string, number>) ?? {};

    // Generate webhook secret if missing
    const webhookSecret = (cfg.webhookSecret as string) ?? randomBytes(32).toString('hex');

    const webhookBaseUrl = config.WEBHOOK_BASE_URL;

    // Diff: find added and removed repos
    const currentNames = new Set(currentRepos.map((r) => r.fullName));
    const newNames = new Set(repos.map((r) => r.fullName));
    const added = repos.filter((r) => !currentNames.has(r.fullName));
    const removed = currentRepos.filter((r) => !newNames.has(r.fullName));

    const updatedWebhookIds = { ...webhookIds };

    // Register webhooks for added repos
    if (webhookBaseUrl) {
      for (const repo of added) {
        try {
          const hook = await githubService.createWebhook(
            accessToken,
            repo.owner,
            repo.name,
            `${webhookBaseUrl}/api/webhooks/github`,
            webhookSecret,
          );
          updatedWebhookIds[repo.fullName] = hook.id;
        } catch (err) {
          request.log.warn({ repo: repo.fullName, err }, 'Failed to create webhook');
        }
      }

      // Delete webhooks for removed repos
      for (const repo of removed) {
        const hookId = webhookIds[repo.fullName];
        if (hookId) {
          try {
            await githubService.deleteWebhook(accessToken, repo.owner, repo.name, hookId);
          } catch (err) {
            request.log.warn({ repo: repo.fullName, err }, 'Failed to delete webhook');
          }
          delete updatedWebhookIds[repo.fullName];
        }
      }
    }

    await db
      .update(integrations)
      .set({
        config: { ...cfg, selectedRepos: repos, webhookSecret, webhookIds: updatedWebhookIds },
        updatedAt: new Date(),
      })
      .where(eq(integrations.id, id));

    return { ok: true };
  });

  // GET /api/integrations/:id/github/synced-repos — enriched synced repo data
  app.get('/:id/github/synced-repos', { preHandler: [requireRole({ minimumRole: 'viewer', source: 'integration' })] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const [integration] = await db
      .select()
      .from(integrations)
      .where(eq(integrations.id, id));

    if (!integration || integration.type !== 'github') {
      reply.code(404);
      return { error: 'GitHub integration not found' };
    }

    const cfg = integration.config as Record<string, unknown>;
    const selectedRepos = (cfg.selectedRepos as Array<{ owner: string; name: string; fullName: string }>) ?? [];
    const webhookIds = (cfg.webhookIds as Record<string, number>) ?? {};

    if (selectedRepos.length === 0) {
      return { repos: [] };
    }

    // Get all team documents for linked doc counting
    const teamDocs = await db
      .select({ id: documents.id, content: documents.content })
      .from(documents)
      .where(eq(documents.teamId, integration.teamId));

    // Get all code_push timeline events for this team's documents
    const teamDocIds = teamDocs.map(d => d.id);
    let pushEvents: Array<{ documentId: string; payload: unknown; createdAt: Date }> = [];
    if (teamDocIds.length > 0) {
      pushEvents = await db
        .select({
          documentId: timelineEvents.documentId,
          payload: timelineEvents.payload,
          createdAt: timelineEvents.createdAt,
        })
        .from(timelineEvents)
        .where(
          and(
            eq(timelineEvents.type, 'code_push'),
            inArray(timelineEvents.documentId, teamDocIds),
          )
        );
    }

    const enrichedRepos = selectedRepos.map(repo => {
      const hasWebhook = !!webhookIds[repo.fullName];

      // Find the most recent push event for this repo
      const repoPushEvents = pushEvents.filter(e => {
        const payload = e.payload as Record<string, unknown>;
        return payload?.repo === repo.fullName || payload?.repository === repo.fullName;
      });
      const lastPush = repoPushEvents.length > 0
        ? repoPushEvents.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]
        : null;

      // Count documents that mention this repo
      const linkedDocCount = teamDocs.filter(d =>
        d.content.includes(repo.fullName) || d.content.includes(repo.name)
      ).length;

      return {
        owner: repo.owner,
        name: repo.name,
        fullName: repo.fullName,
        syncStatus: hasWebhook ? 'active' : 'disconnected',
        webhookId: webhookIds[repo.fullName] ?? null,
        lastPushAt: lastPush?.createdAt ?? null,
        linkedDocCount,
      };
    });

    return { repos: enrichedRepos };
  });

  // DELETE /api/integrations/:id/github/repos/:repoName — disconnect a single repo
  app.delete('/:id/github/repos/:repoName', { preHandler: [requireRole({ minimumRole: 'admin', source: 'integration' })] }, async (request, reply) => {
    const { id, repoName } = request.params as { id: string; repoName: string };
    // repoName is URL-encoded full_name like "owner%2Frepo"
    const fullName = decodeURIComponent(repoName);

    const [integration] = await db
      .select()
      .from(integrations)
      .where(eq(integrations.id, id));

    if (!integration || integration.type !== 'github') {
      reply.code(404);
      return { error: 'GitHub integration not found' };
    }

    const cfg = integration.config as Record<string, unknown>;
    const accessToken = cfg.accessToken as string;
    const selectedRepos = (cfg.selectedRepos as Array<{ owner: string; name: string; fullName: string }>) ?? [];
    const webhookIds = (cfg.webhookIds as Record<string, number>) ?? {};

    const repo = selectedRepos.find(r => r.fullName === fullName);
    if (!repo) {
      reply.code(404);
      return { error: 'Repository not found in synced repos' };
    }

    // Delete webhook if exists
    const hookId = webhookIds[fullName];
    if (hookId && accessToken) {
      try {
        await githubService.deleteWebhook(accessToken, repo.owner, repo.name, hookId);
      } catch (err) {
        request.log.warn({ repo: fullName, err }, 'Failed to delete webhook during disconnect');
      }
    }

    const updatedRepos = selectedRepos.filter(r => r.fullName !== fullName);
    const updatedWebhookIds = { ...webhookIds };
    delete updatedWebhookIds[fullName];

    await db
      .update(integrations)
      .set({
        config: { ...cfg, selectedRepos: updatedRepos, webhookIds: updatedWebhookIds },
        updatedAt: new Date(),
      })
      .where(eq(integrations.id, id));

    return { ok: true };
  });

  // ── Generic integration CRUD ───────────────────────────────────────

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
      if (err instanceof GitHubTokenExpiredError) {
        reply.code(401);
        return { ok: false, error: 'github_token_expired', message: err.message };
      }
      const message = err instanceof Error ? err.message : 'Unknown error';
      reply.code(502);
      return { ok: false, message };
    }
  });
};
