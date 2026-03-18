import type { FastifyPluginAsync } from 'fastify';
import { eq, and, inArray } from 'drizzle-orm';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { db } from '../db/index.js';
import { integrations, documents, timelineEvents, teams, teamMembers } from '../db/schema.js';
import { githubService, GitHubTokenExpiredError } from '../services/github.service.js';
import { jiraService } from '../services/jira.service.js';
import { requireRole } from '../middleware/permissions.js';
import { config } from '../lib/config.js';
import {
  otterService,
  exchangeCodeForToken as otterExchangeCode,
  OTTER_OAUTH_AUTHORIZE_URL,
} from '../services/integrations/otter.service.js';
import { semanticParserService } from '../services/voice/semantic-parser.service.js';
import { transformToDocument } from '../services/voice/doc-transformer.service.js';

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
    let { teamId } = request.query as { teamId?: string };

    // Auto-create team if not provided
    if (!teamId) {
      const userId = request.user.id;
      
      // Check if user has any teams
      let userTeams = await db
        .select({ id: teams.id })
        .from(teamMembers)
        .innerJoin(teams, eq(teamMembers.teamId, teams.id))
        .where(eq(teamMembers.userId, userId))
        .limit(1);

      if (userTeams.length === 0) {
        // Create a default team
        const slug = `personal-${userId.slice(0, 8)}`;
        const [team] = await db.insert(teams).values({ name: 'My Workspace', slug }).returning();
        await db.insert(teamMembers).values({ teamId: team.id, userId, role: 'owner' });
        teamId = team.id;
      } else {
        teamId = userTeams[0].id;
      }
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

  // ── Otter.ai OAuth flow ────────────────────────────────────────────

  // GET /api/integrations/otter/connect — initiate Otter.ai OAuth
  app.get('/otter/connect', async (request, reply) => {
    let { teamId } = request.query as { teamId?: string };

    if (!teamId) {
      const userId = request.user.id;
      let userTeams = await db
        .select({ id: teams.id })
        .from(teamMembers)
        .innerJoin(teams, eq(teamMembers.teamId, teams.id))
        .where(eq(teamMembers.userId, userId))
        .limit(1);

      if (userTeams.length === 0) {
        const slug = `personal-${userId.slice(0, 8)}`;
        const [team] = await db.insert(teams).values({ name: 'My Workspace', slug }).returning();
        await db.insert(teamMembers).values({ teamId: team.id, userId, role: 'owner' });
        teamId = team.id;
      } else {
        teamId = userTeams[0].id;
      }
    }

    if (!config.OTTER_CLIENT_ID || !config.OTTER_CLIENT_SECRET) {
      reply.code(500);
      return { error: 'Otter.ai OAuth not configured: OTTER_CLIENT_ID and OTTER_CLIENT_SECRET required' };
    }

    const statePayload = JSON.stringify({ teamId, nonce: randomBytes(16).toString('hex') });
    const state = signState(statePayload);

    reply.setCookie('otter_oauth_state', state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.NODE_ENV === 'production',
      maxAge: 600,
      path: '/',
    });

    const origin = request.headers.referer
      ? new URL(request.headers.referer).origin
      : `${request.protocol}://${request.host}`;

    const params = new URLSearchParams({
      client_id: config.OTTER_CLIENT_ID,
      redirect_uri: `${origin}/api/integrations/otter/callback`,
      response_type: 'code',
      scope: 'speech.read',
      state,
    });

    reply.redirect(`${OTTER_OAUTH_AUTHORIZE_URL}?${params.toString()}`);
  });

  // GET /api/integrations/otter/callback — handle Otter.ai OAuth callback
  app.get('/otter/callback', async (request, reply) => {
    const { code, state } = request.query as { code?: string; state?: string };

    if (!code || !state) {
      reply.code(400);
      return { error: 'Missing code or state parameter' };
    }

    const cookieState = request.cookies.otter_oauth_state;
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
    reply.clearCookie('otter_oauth_state', { path: '/' });

    const origin = request.headers.referer
      ? new URL(request.headers.referer).origin
      : `${request.protocol}://${request.host}`;

    const tokenData = await otterExchangeCode(
      config.OTTER_CLIENT_ID!,
      config.OTTER_CLIENT_SECRET!,
      code,
      `${origin}/api/integrations/otter/callback`,
    );

    const [existing] = await db
      .select()
      .from(integrations)
      .where(and(eq(integrations.teamId, teamId), eq(integrations.type, 'otter')));

    if (existing) {
      await db
        .update(integrations)
        .set({
          config: {
            accessToken: tokenData.access_token,
            refreshToken: tokenData.refresh_token,
            expiresAt: Date.now() + tokenData.expires_in * 1000,
          },
          updatedAt: new Date(),
        })
        .where(eq(integrations.id, existing.id));
    } else {
      await db.insert(integrations).values({
        teamId,
        type: 'otter',
        config: {
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token,
          expiresAt: Date.now() + tokenData.expires_in * 1000,
        },
      });
    }

    reply.redirect('/settings?tab=integrations&otter=connected');
  });

  // GET /api/integrations/otter/transcripts — list Otter.ai speeches for a team
  app.get('/otter/transcripts', async (request, reply) => {
    const { teamId, query, limit } = request.query as {
      teamId?: string;
      query?: string;
      limit?: string;
    };

    if (!teamId) {
      reply.code(400);
      return { error: 'teamId query parameter is required' };
    }

    const [integration] = await db
      .select()
      .from(integrations)
      .where(and(eq(integrations.teamId, teamId), eq(integrations.type, 'otter')));

    if (!integration) {
      reply.code(404);
      return { error: 'Otter.ai integration not found. Please connect Otter.ai first.' };
    }

    const cfg = integration.config as { accessToken?: string };
    if (!cfg.accessToken) {
      reply.code(400);
      return { error: 'Otter.ai access token is missing. Please reconnect.' };
    }

    try {
      const speeches = await otterService.listTranscripts(
        cfg.accessToken,
        limit ? parseInt(limit, 10) : 20,
        query,
      );
      return { speeches };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      reply.code(502);
      return { error: message };
    }
  });

  // POST /api/integrations/otter/import — import an Otter.ai transcript as Nyx document content
  app.post('/otter/import', async (request, reply) => {
    const { teamId, speechId } = request.body as { teamId: string; speechId: string };

    if (!teamId || !speechId) {
      reply.code(400);
      return { error: 'teamId and speechId are required' };
    }

    const [integration] = await db
      .select()
      .from(integrations)
      .where(and(eq(integrations.teamId, teamId), eq(integrations.type, 'otter')));

    if (!integration) {
      reply.code(404);
      return { error: 'Otter.ai integration not found. Please connect Otter.ai first.' };
    }

    const cfg = integration.config as { accessToken?: string };
    if (!cfg.accessToken) {
      reply.code(400);
      return { error: 'Otter.ai access token is missing. Please reconnect.' };
    }

    try {
      // Fetch the full speech including transcript segments
      const speech = await otterService.getSpeech(cfg.accessToken, speechId);
      const plainText = otterService.transcriptToPlainText(speech);

      // Route through the semantic parser to extract structured intelligence
      const parsed = await semanticParserService.parseTranscript(plainText);

      // Build a MeetingIntelligence-compatible object for the doc transformer
      const intelligence = {
        sessionId: `otter-${speechId}`,
        transcript: [],
        decisions: parsed.decisions,
        actionItems: parsed.actionItems,
        codeReferences: parsed.codeReferences,
        openQuestions: parsed.openQuestions,
        summary: parsed.summary,
        duration: speech.duration ?? 0,
        participants: parsed.participants,
        createdAt: speech.start_time ?? new Date().toISOString(),
      };

      const { title, content } = transformToDocument(intelligence);

      return {
        title: speech.title || title,
        content,
        speechId: speech.speech_id,
        duration: speech.duration,
        participants: parsed.participants,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      reply.code(502);
      return { error: message };
    }
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
      type: 'github' | 'jira' | 'confluence' | 'otter';
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
