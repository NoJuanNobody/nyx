import type { FastifyPluginAsync } from 'fastify';
import { eq, and, inArray } from 'drizzle-orm';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { db } from '../db/index.js';
import { integrations, documents, timelineEvents, teams, teamMembers } from '../db/schema.js';
import { githubService, GitHubTokenExpiredError } from '../services/github.service.js';
import { gitlabService, GitLabTokenExpiredError } from '../services/gitlab.service.js';
import { bitbucketService, BitbucketTokenExpiredError } from '../services/bitbucket.service.js';
import { jiraService } from '../services/jira.service.js';
import { otterService } from '../services/integrations/otter.service.js';
import { requireRole } from '../middleware/permissions.js';
import { config } from '../lib/config.js';
import { onboardingService } from '../services/onboarding.service.js';

// Simple state signing for OAuth CSRF protection
const STATE_SECRET = config.CLERK_SECRET_KEY ?? randomBytes(32).toString('hex');

// ── Webhook registration helper ──────────────────────────────────────
// Centralizes webhook creation so PUT /repos, POST /repos/create, and
// POST /repos/:repoName/reconnect all share the same logic and error shape.
type WebhookRegistrationResult =
  | { status: 'ok'; webhookId: number }
  | { status: 'skipped'; reason: 'webhook_base_url_unset' }
  | { status: 'error'; error: string };

async function registerRepoWebhook(params: {
  accessToken: string;
  owner: string;
  name: string;
  webhookSecret: string;
}): Promise<WebhookRegistrationResult> {
  const webhookBaseUrl = config.WEBHOOK_BASE_URL;
  if (!webhookBaseUrl) {
    return { status: 'skipped', reason: 'webhook_base_url_unset' };
  }

  try {
    const hook = await githubService.createWebhook(
      params.accessToken,
      params.owner,
      params.name,
      `${webhookBaseUrl}/api/webhooks/github`,
      params.webhookSecret,
    );
    return { status: 'ok', webhookId: hook.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error creating webhook';
    return { status: 'error', error: message };
  }
}

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

function countLinkedDocs(teamDocs: { content: string }[], fullName: string): number {
  const lower = fullName.toLowerCase();
  return teamDocs.filter(d => d.content.toLowerCase().includes(lower)).length;
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

    // Use APP_URL if set (required in production behind a proxy where request.protocol is unreliable).
    // Fall back to deriving origin from the Referer header (set by the Vite dev proxy) or the request itself.
    const origin = config.APP_URL
      ?? (request.headers.referer
        ? new URL(request.headers.referer).origin
        : `${request.protocol}://${request.host}`);

    const params = new URLSearchParams({
      client_id: config.GITHUB_CLIENT_ID,
      redirect_uri: `${origin}/api/integrations/github/callback`,
      scope: 'repo read:org admin:repo_hook',
      state,
    });

    return { url: `https://github.com/login/oauth/authorize?${params.toString()}` };
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
    reply.redirect(`${config.FRONTEND_URL ?? ''}/app/settings?tab=integrations&github=connected`);
  });

  // ── GitLab OAuth flow ──────────────────────────────────────────────

  // GET /api/integrations/gitlab/connect — initiate GitLab OAuth
  app.get('/gitlab/connect', async (request, reply) => {
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

    if (!config.GITLAB_CLIENT_ID || !config.GITLAB_CLIENT_SECRET) {
      reply.code(500);
      return { error: 'GitLab OAuth not configured: GITLAB_CLIENT_ID and GITLAB_CLIENT_SECRET required' };
    }

    // Configure self-hosted GitLab base URL if provided
    if (config.GITLAB_BASE_URL) {
      gitlabService.setBaseUrl(config.GITLAB_BASE_URL);
    }

    const statePayload = JSON.stringify({ teamId, nonce: randomBytes(16).toString('hex') });
    const state = signState(statePayload);

    reply.setCookie('gitlab_oauth_state', state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.NODE_ENV === 'production',
      maxAge: 600,
      path: '/',
    });

    const origin = request.headers.referer
      ? new URL(request.headers.referer).origin
      : `${request.protocol}://${request.host}`;

    const glBase = config.GITLAB_BASE_URL || 'https://gitlab.com';
    const params = new URLSearchParams({
      client_id: config.GITLAB_CLIENT_ID,
      redirect_uri: `${origin}/api/integrations/gitlab/callback`,
      response_type: 'code',
      scope: 'api read_user read_repository',
      state,
    });

    return { url: `${glBase}/oauth/authorize?${params.toString()}` };
  });

  // GET /api/integrations/gitlab/callback — handle GitLab OAuth callback
  app.get('/gitlab/callback', async (request, reply) => {
    const { code, state } = request.query as { code?: string; state?: string };

    if (!code || !state) {
      reply.code(400);
      return { error: 'Missing code or state parameter' };
    }

    const cookieState = request.cookies.gitlab_oauth_state;
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
    reply.clearCookie('gitlab_oauth_state', { path: '/' });

    if (config.GITLAB_BASE_URL) {
      gitlabService.setBaseUrl(config.GITLAB_BASE_URL);
    }

    const origin = request.headers.referer
      ? new URL(request.headers.referer).origin
      : `${request.protocol}://${request.host}`;

    const tokenData = await gitlabService.exchangeCodeForToken(
      config.GITLAB_CLIENT_ID!,
      config.GITLAB_CLIENT_SECRET!,
      code,
      `${origin}/api/integrations/gitlab/callback`,
    );

    const glUser = await gitlabService.getAuthenticatedUser(tokenData.access_token);

    const [existing] = await db
      .select()
      .from(integrations)
      .where(and(eq(integrations.teamId, teamId), eq(integrations.type, 'gitlab')));

    const configData = {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      gitlabUsername: glUser.login,
      avatarUrl: glUser.avatarUrl,
      baseUrl: config.GITLAB_BASE_URL || null,
    };

    if (existing) {
      await db
        .update(integrations)
        .set({ config: configData, updatedAt: new Date() })
        .where(eq(integrations.id, existing.id));
    } else {
      await db.insert(integrations).values({
        teamId,
        type: 'gitlab',
        config: configData,
      });
    }

    reply.redirect(`${config.FRONTEND_URL ?? ''}/app/settings?tab=integrations&gitlab=connected`);
  });

  // GET /api/integrations/:id/gitlab/repos — list repos for a connected GitLab integration
  app.get('/:id/gitlab/repos', { preHandler: [requireRole({ minimumRole: 'viewer', source: 'integration' })] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const [integration] = await db
      .select()
      .from(integrations)
      .where(eq(integrations.id, id));

    if (!integration || integration.type !== 'gitlab') {
      reply.code(404);
      return { error: 'GitLab integration not found' };
    }

    const cfg = integration.config as { accessToken?: string; baseUrl?: string };
    if (!cfg.accessToken) {
      reply.code(400);
      return { error: 'GitLab access token is missing. Please reconnect the integration.' };
    }

    if (cfg.baseUrl) gitlabService.setBaseUrl(cfg.baseUrl);

    try {
      const repos = await gitlabService.listRepos(cfg.accessToken);
      return { repos };
    } catch (err) {
      if (err instanceof GitLabTokenExpiredError) {
        reply.code(401);
        return { error: 'gitlab_token_expired', message: err.message };
      }
      const message = err instanceof Error ? err.message : 'Unknown error';
      reply.code(502);
      return { error: message };
    }
  });

  // ── Bitbucket OAuth flow ──────────────────────────────────────────────

  // GET /api/integrations/bitbucket/connect — initiate Bitbucket OAuth
  app.get('/bitbucket/connect', async (request, reply) => {
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

    if (!config.BITBUCKET_CLIENT_ID || !config.BITBUCKET_CLIENT_SECRET) {
      reply.code(500);
      return { error: 'Bitbucket OAuth not configured: BITBUCKET_CLIENT_ID and BITBUCKET_CLIENT_SECRET required' };
    }

    const statePayload = JSON.stringify({ teamId, nonce: randomBytes(16).toString('hex') });
    const state = signState(statePayload);

    reply.setCookie('bitbucket_oauth_state', state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.NODE_ENV === 'production',
      maxAge: 600,
      path: '/',
    });

    const params = new URLSearchParams({
      client_id: config.BITBUCKET_CLIENT_ID,
      response_type: 'code',
      state,
    });

    return { url: `https://bitbucket.org/site/oauth2/authorize?${params.toString()}` };
  });

  // GET /api/integrations/bitbucket/callback — handle Bitbucket OAuth callback
  app.get('/bitbucket/callback', async (request, reply) => {
    const { code, state } = request.query as { code?: string; state?: string };

    if (!code || !state) {
      reply.code(400);
      return { error: 'Missing code or state parameter' };
    }

    const cookieState = request.cookies.bitbucket_oauth_state;
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
    reply.clearCookie('bitbucket_oauth_state', { path: '/' });

    const tokenData = await bitbucketService.exchangeCodeForToken(
      config.BITBUCKET_CLIENT_ID!,
      config.BITBUCKET_CLIENT_SECRET!,
      code,
    );

    const bbUser = await bitbucketService.getAuthenticatedUser(tokenData.access_token);

    const [existing] = await db
      .select()
      .from(integrations)
      .where(and(eq(integrations.teamId, teamId), eq(integrations.type, 'bitbucket')));

    const configData = {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      bitbucketUsername: bbUser.login,
      avatarUrl: bbUser.avatarUrl,
    };

    if (existing) {
      await db
        .update(integrations)
        .set({ config: configData, updatedAt: new Date() })
        .where(eq(integrations.id, existing.id));
    } else {
      await db.insert(integrations).values({
        teamId,
        type: 'bitbucket',
        config: configData,
      });
    }

    reply.redirect(`${config.FRONTEND_URL ?? ''}/app/settings?tab=integrations&bitbucket=connected`);
  });

  // ── Provider-agnostic repo endpoints ─────────────────────────────────
  // These dispatch to the right provider based on integration.type, so the
  // Repositories UI doesn't need to know which provider is connected.

  // GET /api/integrations/:id/synced-repos — enriched synced repo list (any provider)
  app.get('/:id/synced-repos', { preHandler: [requireRole({ minimumRole: 'viewer', source: 'integration' })] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const [integration] = await db
      .select()
      .from(integrations)
      .where(eq(integrations.id, id));

    if (!integration || !['github', 'gitlab', 'bitbucket'].includes(integration.type)) {
      reply.code(404);
      return { error: 'Git integration not found' };
    }

    const cfg = integration.config as Record<string, unknown>;
    const selectedRepos = (cfg.selectedRepos as Array<{ owner: string; name: string; fullName: string }>) ?? [];

    if (selectedRepos.length === 0) {
      return {
        repos: [],
        webhookRegistrationEnabled: integration.type === 'github' ? !!config.WEBHOOK_BASE_URL : false,
        provider: integration.type,
      };
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

    if (integration.type === 'github') {
      const webhookIds = (cfg.webhookIds as Record<string, number>) ?? {};
      const enrichedRepos = selectedRepos.map(repo => {
        const hasWebhook = !!webhookIds[repo.fullName];
        const repoPushEvents = pushEvents.filter(e => {
          const payload = e.payload as Record<string, unknown>;
          return payload?.repo === repo.fullName || payload?.repository === repo.fullName;
        });
        const lastPush = repoPushEvents.length > 0
          ? repoPushEvents.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]
          : null;
        const linkedDocCount = countLinkedDocs(teamDocs, repo.fullName);
        return {
          owner: repo.owner,
          name: repo.name,
          fullName: repo.fullName,
          syncStatus: hasWebhook ? 'active' : 'disconnected',
          webhookId: webhookIds[repo.fullName] ?? null,
          lastPushAt: lastPush?.createdAt ?? null,
          linkedDocCount,
          provider: 'github' as const,
        };
      });
      return {
        repos: enrichedRepos,
        webhookRegistrationEnabled: !!config.WEBHOOK_BASE_URL,
        provider: 'github' as const,
      };
    }

    // GitLab / Bitbucket — selectedRepos tracked in config, no webhook tracking yet
    const enrichedRepos = selectedRepos.map(repo => {
      const repoPushEvents = pushEvents.filter(e => {
        const payload = e.payload as Record<string, unknown>;
        return payload?.repo === repo.fullName || payload?.repository === repo.fullName;
      });
      const lastPush = repoPushEvents.length > 0
        ? repoPushEvents.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]
        : null;
      const linkedDocCount = countLinkedDocs(teamDocs, repo.fullName);
      return {
        owner: repo.owner,
        name: repo.name,
        fullName: repo.fullName,
        syncStatus: 'active' as const,
        webhookId: null,
        lastPushAt: lastPush?.createdAt ?? null,
        linkedDocCount,
        provider: integration.type as 'gitlab' | 'bitbucket',
      };
    });

    return {
      repos: enrichedRepos,
      webhookRegistrationEnabled: false,
      provider: integration.type as 'gitlab' | 'bitbucket',
    };
  });

  // PUT /api/integrations/:id/repos — save selected repos for any provider
  app.put('/:id/repos', { preHandler: [requireRole({ minimumRole: 'admin', source: 'integration' })] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { repos } = request.body as { repos: Array<{ owner: string; name: string; fullName: string }> };

    const [integration] = await db
      .select()
      .from(integrations)
      .where(eq(integrations.id, id));

    if (!integration || !['github', 'gitlab', 'bitbucket'].includes(integration.type)) {
      reply.code(404);
      return { error: 'Git integration not found' };
    }

    const cfg = integration.config as Record<string, unknown>;

    if (integration.type === 'github') {
      const accessToken = cfg.accessToken as string;
      const currentRepos = (cfg.selectedRepos as Array<{ owner: string; name: string; fullName: string }>) ?? [];
      const webhookIds = (cfg.webhookIds as Record<string, number>) ?? {};
      const webhookSecret = (cfg.webhookSecret as string) ?? randomBytes(32).toString('hex');
      const webhookRegistrationEnabled = !!config.WEBHOOK_BASE_URL;

      const currentNames = new Set(currentRepos.map((r) => r.fullName));
      const newNames = new Set(repos.map((r) => r.fullName));
      const added = repos.filter((r) => !currentNames.has(r.fullName));
      const removed = currentRepos.filter((r) => !newNames.has(r.fullName));

      const updatedWebhookIds = { ...webhookIds };
      const failed: Array<{ repo: string; error: string }> = [];
      const skipped: string[] = [];

      for (const repo of added) {
        const result = await registerRepoWebhook({ accessToken, owner: repo.owner, name: repo.name, webhookSecret });
        if (result.status === 'ok') {
          updatedWebhookIds[repo.fullName] = result.webhookId;
        } else if (result.status === 'error') {
          request.log.warn({ repo: repo.fullName, err: result.error }, 'Failed to create webhook');
          failed.push({ repo: repo.fullName, error: result.error });
        } else {
          skipped.push(repo.fullName);
        }
      }

      if (webhookRegistrationEnabled) {
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

      return { ok: true, webhookRegistrationEnabled, failed, skipped };
    }

    // GitLab / Bitbucket — just save selectedRepos to config
    await db
      .update(integrations)
      .set({
        config: { ...cfg, selectedRepos: repos },
        updatedAt: new Date(),
      })
      .where(eq(integrations.id, id));

    // Mark onboarding step
    if (request.user?.id) {
      await onboardingService.markStepComplete(request.user.id, 'repo-connected').catch(() => {});
    }

    return { ok: true, webhookRegistrationEnabled: false, failed: [], skipped: [] };
  });

  // POST /api/integrations/:id/repos/:repoName/reconnect — reconnect webhook (any provider)
  app.post('/:id/repos/:repoName/reconnect', { preHandler: [requireRole({ minimumRole: 'admin', source: 'integration' })] }, async (request, reply) => {
    const { id, repoName } = request.params as { id: string; repoName: string };
    const fullName = decodeURIComponent(repoName);

    const [integration] = await db
      .select()
      .from(integrations)
      .where(eq(integrations.id, id));

    if (!integration || !['github', 'gitlab', 'bitbucket'].includes(integration.type)) {
      reply.code(404);
      return { error: 'Git integration not found' };
    }

    if (integration.type !== 'github') {
      // GitLab/Bitbucket: just confirm repo is still in selectedRepos
      const cfg = integration.config as Record<string, unknown>;
      const selectedRepos = (cfg.selectedRepos as Array<{ owner: string; name: string; fullName: string }>) ?? [];
      const repo = selectedRepos.find((r) => r.fullName === fullName);
      if (!repo) {
        reply.code(404);
        return { error: 'Repository not found in synced repos' };
      }
      return { ok: true, fullName, webhookId: null, syncStatus: 'active' as const };
    }

    // GitHub — retry webhook registration
    const cfg = integration.config as Record<string, unknown>;
    const accessToken = cfg.accessToken as string | undefined;
    const selectedRepos = (cfg.selectedRepos as Array<{ owner: string; name: string; fullName: string }>) ?? [];
    const webhookIds = (cfg.webhookIds as Record<string, number>) ?? {};
    const webhookSecret = (cfg.webhookSecret as string) ?? randomBytes(32).toString('hex');

    if (!accessToken) {
      reply.code(400);
      return { error: 'GitHub access token is missing. Please reconnect the integration.' };
    }

    if (!config.WEBHOOK_BASE_URL) {
      reply.code(503);
      return {
        error: 'webhook_registration_disabled',
        message: 'WEBHOOK_BASE_URL is not configured on the server.',
      };
    }

    const repo = selectedRepos.find((r) => r.fullName === fullName);
    if (!repo) {
      reply.code(404);
      return { error: 'Repository not found in synced repos' };
    }

    const result = await registerRepoWebhook({ accessToken, owner: repo.owner, name: repo.name, webhookSecret });

    if (result.status === 'error') {
      reply.code(502);
      return { error: 'webhook_creation_failed', message: result.error };
    }

    if (result.status === 'skipped') {
      reply.code(503);
      return { error: 'webhook_registration_disabled', message: 'Webhook registration is disabled on the server.' };
    }

    const updatedWebhookIds = { ...webhookIds, [fullName]: result.webhookId };
    await db
      .update(integrations)
      .set({
        config: { ...cfg, webhookSecret, webhookIds: updatedWebhookIds },
        updatedAt: new Date(),
      })
      .where(eq(integrations.id, id));

    return { ok: true, fullName, webhookId: result.webhookId, syncStatus: 'active' as const };
  });

  // DELETE /api/integrations/:id/repos/:repoName — disconnect a single repo (any provider)
  app.delete('/:id/repos/:repoName', { preHandler: [requireRole({ minimumRole: 'admin', source: 'integration' })] }, async (request, reply) => {
    const { id, repoName } = request.params as { id: string; repoName: string };
    const fullName = decodeURIComponent(repoName);

    const [integration] = await db
      .select()
      .from(integrations)
      .where(eq(integrations.id, id));

    if (!integration || !['github', 'gitlab', 'bitbucket'].includes(integration.type)) {
      reply.code(404);
      return { error: 'Git integration not found' };
    }

    const cfg = integration.config as Record<string, unknown>;
    const selectedRepos = (cfg.selectedRepos as Array<{ owner: string; name: string; fullName: string }>) ?? [];

    const repo = selectedRepos.find(r => r.fullName === fullName);
    if (!repo) {
      reply.code(404);
      return { error: 'Repository not found in synced repos' };
    }

    if (integration.type === 'github') {
      const accessToken = cfg.accessToken as string;
      const webhookIds = (cfg.webhookIds as Record<string, number>) ?? {};
      const hookId = webhookIds[fullName];
      if (hookId && accessToken) {
        try {
          await githubService.deleteWebhook(accessToken, repo.owner, repo.name, hookId);
        } catch (err) {
          request.log.warn({ repo: fullName, err }, 'Failed to delete webhook during disconnect');
        }
      }
      const updatedWebhookIds = { ...webhookIds };
      delete updatedWebhookIds[fullName];
      const updatedRepos = selectedRepos.filter(r => r.fullName !== fullName);
      await db
        .update(integrations)
        .set({
          config: { ...cfg, selectedRepos: updatedRepos, webhookIds: updatedWebhookIds },
          updatedAt: new Date(),
        })
        .where(eq(integrations.id, id));
      return { ok: true };
    }

    // GitLab / Bitbucket
    const updatedRepos = selectedRepos.filter(r => r.fullName !== fullName);
    await db
      .update(integrations)
      .set({
        config: { ...cfg, selectedRepos: updatedRepos },
        updatedAt: new Date(),
      })
      .where(eq(integrations.id, id));

    return { ok: true };
  });

  // GET /api/integrations/:id/bitbucket/repos — list repos for a connected Bitbucket integration
  app.get('/:id/bitbucket/repos', { preHandler: [requireRole({ minimumRole: 'viewer', source: 'integration' })] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const [integration] = await db
      .select()
      .from(integrations)
      .where(eq(integrations.id, id));

    if (!integration || integration.type !== 'bitbucket') {
      reply.code(404);
      return { error: 'Bitbucket integration not found' };
    }

    const cfg = integration.config as { accessToken?: string };
    if (!cfg.accessToken) {
      reply.code(400);
      return { error: 'Bitbucket access token is missing. Please reconnect the integration.' };
    }

    try {
      const repos = await bitbucketService.listRepos(cfg.accessToken);
      return { repos };
    } catch (err) {
      if (err instanceof BitbucketTokenExpiredError) {
        reply.code(401);
        return { error: 'bitbucket_token_expired', message: err.message };
      }
      const message = err instanceof Error ? err.message : 'Unknown error';
      reply.code(502);
      return { error: message };
    }
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

    const webhookRegistrationEnabled = !!config.WEBHOOK_BASE_URL;

    // Diff: find added and removed repos
    const currentNames = new Set(currentRepos.map((r) => r.fullName));
    const newNames = new Set(repos.map((r) => r.fullName));
    const added = repos.filter((r) => !currentNames.has(r.fullName));
    const removed = currentRepos.filter((r) => !newNames.has(r.fullName));

    const updatedWebhookIds = { ...webhookIds };
    const failed: Array<{ repo: string; error: string }> = [];
    const skipped: string[] = [];

    // Register webhooks for added repos
    for (const repo of added) {
      const result = await registerRepoWebhook({
        accessToken,
        owner: repo.owner,
        name: repo.name,
        webhookSecret,
      });
      if (result.status === 'ok') {
        updatedWebhookIds[repo.fullName] = result.webhookId;
      } else if (result.status === 'error') {
        request.log.warn({ repo: repo.fullName, err: result.error }, 'Failed to create webhook');
        failed.push({ repo: repo.fullName, error: result.error });
      } else {
        skipped.push(repo.fullName);
      }
    }

    // Delete webhooks for removed repos (only when registration is enabled —
    // otherwise there's nothing to delete server-side)
    if (webhookRegistrationEnabled) {
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

    // Mark onboarding step
    if (request.user?.id) {
      await onboardingService.markStepComplete(request.user.id, 'repo-connected').catch(() => {});
    }

    return {
      ok: true,
      webhookRegistrationEnabled,
      failed,
      skipped,
    };
  });

  // POST /api/integrations/:id/github/repos/create — create a new GitHub repo
  app.post('/:id/github/repos/create', { preHandler: [requireRole({ minimumRole: 'admin', source: 'integration' })] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { name, description, isPrivate, autoInit } = request.body as {
      name: string;
      description?: string;
      isPrivate?: boolean;
      autoInit?: boolean;
    };

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      reply.code(400);
      return { error: 'Repository name is required' };
    }

    // Validate repo name format (GitHub rules: alphanumeric, hyphens, underscores, dots)
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
      reply.code(400);
      return { error: 'Invalid repository name. Use only alphanumeric characters, hyphens, underscores, and dots.' };
    }

    const [integration] = await db
      .select()
      .from(integrations)
      .where(eq(integrations.id, id));

    if (!integration || integration.type !== 'github') {
      reply.code(404);
      return { error: 'GitHub integration not found' };
    }

    const cfg = integration.config as Record<string, unknown>;
    const accessToken = cfg.accessToken as string | undefined;

    if (!accessToken) {
      reply.code(400);
      return { error: 'GitHub access token is missing. Please reconnect the integration.' };
    }

    try {
      const repo = await githubService.createRepo(
        accessToken,
        name.trim(),
        description,
        isPrivate,
        autoInit,
      );

      // Auto-add created repo to selectedRepos and register webhook
      const selectedRepos = (cfg.selectedRepos as Array<{ owner: string; name: string; fullName: string }>) ?? [];
      const webhookIds = (cfg.webhookIds as Record<string, number>) ?? {};
      const webhookSecret = (cfg.webhookSecret as string) ?? randomBytes(32).toString('hex');

      const [owner, repoName] = repo.full_name.split('/');
      const newEntry = { owner, name: repoName, fullName: repo.full_name };

      const updatedRepos = selectedRepos.some((r) => r.fullName === repo.full_name)
        ? selectedRepos
        : [...selectedRepos, newEntry];

      const updatedWebhookIds = { ...webhookIds };
      let webhookFailure: string | null = null;
      let webhookSkipped = false;

      // Register webhook for the new repo
      if (!webhookIds[repo.full_name]) {
        const result = await registerRepoWebhook({
          accessToken,
          owner,
          name: repoName,
          webhookSecret,
        });
        if (result.status === 'ok') {
          updatedWebhookIds[repo.full_name] = result.webhookId;
        } else if (result.status === 'error') {
          request.log.warn({ repo: repo.full_name, err: result.error }, 'Failed to create webhook for newly created repo');
          webhookFailure = result.error;
        } else {
          webhookSkipped = true;
        }
      }

      await db
        .update(integrations)
        .set({
          config: { ...cfg, selectedRepos: updatedRepos, webhookSecret, webhookIds: updatedWebhookIds },
          updatedAt: new Date(),
        })
        .where(eq(integrations.id, id));

      reply.code(201);
      return {
        repo,
        webhookRegistrationEnabled: !!config.WEBHOOK_BASE_URL,
        webhookSkipped,
        webhookError: webhookFailure,
      };
    } catch (err) {
      if (err instanceof GitHubTokenExpiredError) {
        reply.code(401);
        return { error: 'github_token_expired', message: err.message };
      }
      const message = err instanceof Error ? err.message : 'Unknown error';
      reply.code(422);
      return { error: message };
    }
  });

  // POST /api/integrations/:id/gitlab/repos/create — create a new GitLab project
  app.post('/:id/gitlab/repos/create', { preHandler: [requireRole({ minimumRole: 'admin', source: 'integration' })] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { name, description, isPrivate } = request.body as { name: string; description?: string; isPrivate?: boolean };

    const [integration] = await db
      .select()
      .from(integrations)
      .where(eq(integrations.id, id));

    if (!integration || integration.type !== 'gitlab') {
      reply.code(404);
      return { error: 'GitLab integration not found' };
    }

    const cfg = integration.config as { accessToken?: string; baseUrl?: string };
    if (!cfg.accessToken) {
      reply.code(400);
      return { error: 'GitLab access token is missing. Please reconnect the integration.' };
    }

    if (cfg.baseUrl) gitlabService.setBaseUrl(cfg.baseUrl);

    try {
      const repo = await gitlabService.createRepo(cfg.accessToken, { name, description, isPrivate });
      const [owner, repoName] = repo.fullName.split('/');
      await db
        .update(integrations)
        .set({
          config: {
            ...cfg,
            selectedRepos: [
              ...((integration.config as { selectedRepos?: Array<{ owner: string; name: string; fullName: string }> }).selectedRepos ?? []),
              { owner, name: repoName, fullName: repo.fullName },
            ],
          },
        })
        .where(eq(integrations.id, id));
      return { repo };
    } catch (err) {
      if (err instanceof GitLabTokenExpiredError) {
        reply.code(401);
        return { error: 'gitlab_token_expired', message: (err as Error).message };
      }
      reply.code(500);
      return { error: (err as Error).message };
    }
  });

  // POST /api/integrations/:id/bitbucket/repos/create — create a new Bitbucket repo
  app.post('/:id/bitbucket/repos/create', { preHandler: [requireRole({ minimumRole: 'admin', source: 'integration' })] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { name, description, isPrivate } = request.body as { name: string; description?: string; isPrivate?: boolean };

    const [integration] = await db
      .select()
      .from(integrations)
      .where(eq(integrations.id, id));

    if (!integration || integration.type !== 'bitbucket') {
      reply.code(404);
      return { error: 'Bitbucket integration not found' };
    }

    const cfg = integration.config as { accessToken?: string; bitbucketUsername?: string };
    if (!cfg.accessToken) {
      reply.code(400);
      return { error: 'Bitbucket access token is missing. Please reconnect the integration.' };
    }
    if (!cfg.bitbucketUsername) {
      reply.code(400);
      return { error: 'Bitbucket workspace (username) is missing. Please reconnect the integration.' };
    }

    try {
      const repo = await bitbucketService.createRepo(cfg.accessToken, cfg.bitbucketUsername, { name, description, isPrivate });
      const [owner, repoName] = repo.fullName.split('/');
      await db
        .update(integrations)
        .set({
          config: {
            ...cfg,
            selectedRepos: [
              ...((integration.config as { selectedRepos?: Array<{ owner: string; name: string; fullName: string }> }).selectedRepos ?? []),
              { owner, name: repoName, fullName: repo.fullName },
            ],
          },
        })
        .where(eq(integrations.id, id));
      return { repo };
    } catch (err) {
      if (err instanceof BitbucketTokenExpiredError) {
        reply.code(401);
        return { error: 'bitbucket_token_expired', message: (err as Error).message };
      }
      reply.code(500);
      return { error: (err as Error).message };
    }
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
      const linkedDocCount = countLinkedDocs(teamDocs, repo.fullName);

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

    return {
      repos: enrichedRepos,
      webhookRegistrationEnabled: !!config.WEBHOOK_BASE_URL,
    };
  });

  // POST /api/integrations/:id/github/repos/:repoName/reconnect — retry webhook
  // registration for a single repo. Used by the Repositories UI when a repo
  // shows as "Disconnected" because a previous webhook creation failed
  // (env was correct, GitHub call errored). Reuses the shared helper so the
  // success path stays centralized with the bulk save flow.
  app.post('/:id/github/repos/:repoName/reconnect', { preHandler: [requireRole({ minimumRole: 'admin', source: 'integration' })] }, async (request, reply) => {
    const { id, repoName } = request.params as { id: string; repoName: string };
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
    const accessToken = cfg.accessToken as string | undefined;
    const selectedRepos = (cfg.selectedRepos as Array<{ owner: string; name: string; fullName: string }>) ?? [];
    const webhookIds = (cfg.webhookIds as Record<string, number>) ?? {};
    const webhookSecret = (cfg.webhookSecret as string) ?? randomBytes(32).toString('hex');

    if (!accessToken) {
      reply.code(400);
      return { error: 'GitHub access token is missing. Please reconnect the integration.' };
    }

    if (!config.WEBHOOK_BASE_URL) {
      reply.code(503);
      return {
        error: 'webhook_registration_disabled',
        message: 'WEBHOOK_BASE_URL is not configured on the server. Live sync cannot be enabled until an operator sets this environment variable.',
      };
    }

    const repo = selectedRepos.find((r) => r.fullName === fullName);
    if (!repo) {
      reply.code(404);
      return { error: 'Repository not found in synced repos' };
    }

    const result = await registerRepoWebhook({
      accessToken,
      owner: repo.owner,
      name: repo.name,
      webhookSecret,
    });

    if (result.status === 'error') {
      request.log.warn({ repo: fullName, err: result.error }, 'Reconnect: failed to create webhook');
      reply.code(502);
      return {
        error: 'webhook_creation_failed',
        message: result.error,
      };
    }

    // result.status === 'skipped' is unreachable here because we already
    // checked WEBHOOK_BASE_URL above, but handle it defensively.
    if (result.status === 'skipped') {
      reply.code(503);
      return {
        error: 'webhook_registration_disabled',
        message: 'Webhook registration is disabled on the server.',
      };
    }

    const updatedWebhookIds = { ...webhookIds, [fullName]: result.webhookId };

    await db
      .update(integrations)
      .set({
        config: { ...cfg, webhookSecret, webhookIds: updatedWebhookIds },
        updatedAt: new Date(),
      })
      .where(eq(integrations.id, id));

    return {
      ok: true,
      fullName,
      webhookId: result.webhookId,
      syncStatus: 'active' as const,
    };
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

  // ── Otter.ai transcript import ────────────────────────────────────

  // POST /api/integrations/otter/import — import an Otter.ai transcript into a document
  app.post('/otter/import', async (request, reply) => {
    const { transcriptText, documentId } = request.body as {
      transcriptText?: string;
      documentId?: string;
    };

    if (!transcriptText || !documentId) {
      reply.code(400);
      return { error: 'transcriptText and documentId are required' };
    }

    // Fetch the target document
    const [doc] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, documentId));

    if (!doc) {
      reply.code(404);
      return { error: 'Document not found' };
    }

    try {
      const { content, formattedText } = otterService.importTranscript(
        transcriptText,
        doc.content,
      );

      // Update the document with the appended transcript
      await db
        .update(documents)
        .set({ content, updatedAt: new Date() })
        .where(eq(documents.id, documentId));

      return {
        ok: true,
        documentId,
        appendedLength: formattedText.length,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      reply.code(400);
      return { error: message };
    }
  });

  // GET /api/integrations/otter/transcripts — list available Otter.ai transcripts
  app.get('/otter/transcripts', async (_request, reply) => {
    try {
      const transcripts = await otterService.listTranscripts();
      return { transcripts };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      reply.code(502);
      return { error: message };
    }
  });

  // GET /api/integrations/otter/transcripts/:id — get a single Otter.ai transcript
  app.get('/otter/transcripts/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      const transcript = await otterService.getTranscript(id);
      return { transcript };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      if (message.includes('not found')) {
        reply.code(404);
      } else {
        reply.code(502);
      }
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
      type: 'github' | 'gitlab' | 'bitbucket' | 'jira' | 'confluence';
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

      if (integration.type === 'gitlab') {
        if (config.baseUrl) gitlabService.setBaseUrl(config.baseUrl as string);
        const repos = await gitlabService.listRepos(config.accessToken as string);
        return { ok: true, message: `Connected. Found ${repos.length} repos.` };
      }

      if (integration.type === 'bitbucket') {
        const repos = await bitbucketService.listRepos(config.accessToken as string);
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
      if (err instanceof GitLabTokenExpiredError) {
        reply.code(401);
        return { ok: false, error: 'gitlab_token_expired', message: err.message };
      }
      if (err instanceof BitbucketTokenExpiredError) {
        reply.code(401);
        return { ok: false, error: 'bitbucket_token_expired', message: err.message };
      }
      const message = err instanceof Error ? err.message : 'Unknown error';
      reply.code(502);
      return { ok: false, message };
    }
  });
};
