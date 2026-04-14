import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { slackConnections } from '../db/schema.js';
import { config } from '../lib/config.js';
import { encrypt, decrypt } from '../lib/encryption.js';
import { requireRole } from '../middleware/permissions.js';
import { slackService } from '../services/slack.service.js';

export const slackRoutes: FastifyPluginAsync = async (app) => {
  // Slack sends application/x-www-form-urlencoded for slash commands
  // and application/json for events. We need raw body for signature verification.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      done(null, body as string);
    },
  );

  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => {
      try {
        done(null, JSON.parse(body as string));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  /**
   * POST /api/slack/command — handles /nyx slash command
   */
  app.post('/command', async (request, reply) => {
    const rawBody = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
    const slackSignature = request.headers['x-slack-signature'] as string | undefined;
    const slackTimestamp = request.headers['x-slack-request-timestamp'] as string | undefined;

    // Verify signature if signing secret is configured
    if (config.SLACK_SIGNING_SECRET) {
      if (!slackSignature || !slackTimestamp) {
        reply.code(401);
        return { error: 'Missing Slack signature headers' };
      }
      if (!slackService.verifySlackSignature(slackSignature, slackTimestamp, rawBody, config.SLACK_SIGNING_SECRET)) {
        reply.code(401);
        return { error: 'Invalid Slack signature' };
      }
    } else if (config.NODE_ENV === 'production') {
      reply.code(500);
      return { error: 'SLACK_SIGNING_SECRET is not configured' };
    }

    // Parse the URL-encoded body from Slack slash command
    const params = new URLSearchParams(rawBody);
    const text = params.get('text') ?? '';
    const slackTeamId = params.get('team_id') ?? '';
    const slackUserId = params.get('user_id') ?? '';
    const channelId = params.get('channel_id') ?? '';
    const responseUrl = params.get('response_url') ?? '';

    // Find linked Nyx team
    const connections = await db
      .select()
      .from(slackConnections)
      .where(eq(slackConnections.slackTeamId, slackTeamId));

    if (connections.length === 0) {
      return {
        response_type: 'ephemeral',
        text: 'This Slack workspace is not connected to a Nyx team. Visit Nyx Settings to connect.',
      };
    }

    const connection = connections[0];

    // Process through intake
    const result = await slackService.processSlackMessage(text, connection.teamId, slackUserId, channelId);

    // Send async response if we have a response URL
    if (responseUrl) {
      setImmediate(async () => {
        try {
          await slackService.sendSlackResponse(responseUrl, {
            response_type: 'in_channel',
            text: `Nyx processed your input:\n> ${result.summary}`,
          });
        } catch {
          // Best-effort response
        }
      });
    }

    return {
      response_type: 'ephemeral',
      text: `Processing your input: "${text}"`,
    };
  });

  /**
   * POST /api/slack/events — handles Slack Events API
   * Supports url_verification challenge and event_callback for reaction_added and message events
   */
  app.post('/events', async (request, reply) => {
    const body = request.body as Record<string, unknown>;

    // Handle URL verification challenge
    if (body.type === 'url_verification') {
      return { challenge: body.challenge };
    }

    // Verify signature for event callbacks
    const rawBody = JSON.stringify(body);
    const slackSignature = request.headers['x-slack-signature'] as string | undefined;
    const slackTimestamp = request.headers['x-slack-request-timestamp'] as string | undefined;

    if (config.SLACK_SIGNING_SECRET) {
      if (!slackSignature || !slackTimestamp) {
        reply.code(401);
        return { error: 'Missing Slack signature headers' };
      }
      if (!slackService.verifySlackSignature(slackSignature, slackTimestamp, rawBody, config.SLACK_SIGNING_SECRET)) {
        reply.code(401);
        return { error: 'Invalid Slack signature' };
      }
    } else if (config.NODE_ENV === 'production') {
      reply.code(500);
      return { error: 'SLACK_SIGNING_SECRET is not configured' };
    }

    if (body.type !== 'event_callback') {
      return { ok: true };
    }

    const event = body.event as Record<string, unknown> | undefined;
    if (!event) {
      return { ok: true };
    }

    const slackTeamId = (body.team_id as string) ?? '';
    const connections = await db
      .select()
      .from(slackConnections)
      .where(eq(slackConnections.slackTeamId, slackTeamId));

    if (connections.length === 0) {
      return { ok: true };
    }

    const connection = connections[0];
    const eventType = event.type as string;

    if (eventType === 'reaction_added') {
      const reaction = event.reaction as string;
      // Check if the reaction matches the configured trigger emoji
      if (reaction === connection.triggerEmoji) {
        const itemUser = (event.item_user as string) ?? '';
        const channel = ((event.item as Record<string, unknown>)?.channel as string) ?? '';
        // Fire-and-forget processing
        setImmediate(async () => {
          try {
            await slackService.processSlackMessage(
              `[Reaction trigger: :${reaction}:]`,
              connection.teamId,
              itemUser,
              channel,
            );
          } catch {
            // Best-effort
          }
        });
      }
    } else if (eventType === 'message' && !event.bot_id) {
      const channelId = event.channel as string;
      const monitoredChannels = (connection.monitoredChannels as string[]) ?? [];
      // Only process messages from monitored channels
      if (monitoredChannels.includes(channelId)) {
        const text = (event.text as string) ?? '';
        const userId = (event.user as string) ?? '';
        setImmediate(async () => {
          try {
            await slackService.processSlackMessage(text, connection.teamId, userId, channelId);
          } catch {
            // Best-effort
          }
        });
      }
    }

    // Acknowledge immediately — Slack requires a 200 within 3 seconds
    return { ok: true };
  });

  /**
   * GET /api/slack/install?teamId=X — returns Slack OAuth install URL
   */
  app.get('/install', { preHandler: [requireRole({ minimumRole: 'admin', source: 'request' })] }, async (request, reply) => {
    const { teamId } = request.query as { teamId?: string };

    if (!teamId) {
      reply.code(400);
      return { error: 'teamId is required' };
    }

    if (!config.SLACK_CLIENT_ID) {
      reply.code(500);
      return { error: 'SLACK_CLIENT_ID is not configured' };
    }

    const scopes = [
      'channels:history',
      'channels:read',
      'chat:write',
      'commands',
      'reactions:read',
    ].join(',');

    const url = new URL('https://slack.com/oauth/v2/authorize');
    url.searchParams.set('client_id', config.SLACK_CLIENT_ID);
    url.searchParams.set('scope', scopes);
    url.searchParams.set('state', teamId);

    return { url: url.toString() };
  });

  /**
   * GET /api/slack/callback — OAuth callback after Slack app installation
   */
  app.get('/callback', async (request, reply) => {
    const { code, state: teamId } = request.query as { code?: string; state?: string };

    if (!code || !teamId) {
      reply.code(400);
      return { error: 'Missing code or state (teamId)' };
    }

    if (!config.SLACK_CLIENT_ID || !config.SLACK_CLIENT_SECRET) {
      reply.code(500);
      return { error: 'Slack OAuth credentials are not configured' };
    }

    // Exchange code for access token
    const tokenResponse = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.SLACK_CLIENT_ID,
        client_secret: config.SLACK_CLIENT_SECRET,
        code,
      }),
    });

    const tokenData = (await tokenResponse.json()) as {
      ok: boolean;
      access_token?: string;
      team?: { id?: string };
      error?: string;
    };

    if (!tokenData.ok || !tokenData.access_token || !tokenData.team?.id) {
      reply.code(400);
      return { error: tokenData.error ?? 'Failed to complete Slack OAuth' };
    }

    // Encrypt the bot token before storing
    const encryptedToken = encrypt(tokenData.access_token);

    // Upsert connection
    const existing = await db
      .select()
      .from(slackConnections)
      .where(eq(slackConnections.teamId, teamId));

    if (existing.length > 0) {
      await db
        .update(slackConnections)
        .set({
          slackTeamId: tokenData.team.id,
          slackBotToken: encryptedToken,
        })
        .where(eq(slackConnections.teamId, teamId));
    } else {
      await db.insert(slackConnections).values({
        teamId,
        slackTeamId: tokenData.team.id,
        slackBotToken: encryptedToken,
      });
    }

    // Redirect back to settings
    reply.redirect('/app/settings?tab=integrations&slack=connected');
  });

  /**
   * GET /api/slack/connection?teamId=X — returns the Slack connection for a team
   */
  app.get('/connection', { preHandler: [requireRole({ minimumRole: 'viewer', source: 'request' })] }, async (request, reply) => {
    const { teamId } = request.query as { teamId?: string };

    if (!teamId) {
      reply.code(400);
      return { error: 'teamId is required' };
    }

    const connections = await db
      .select({
        id: slackConnections.id,
        slackTeamId: slackConnections.slackTeamId,
        triggerEmoji: slackConnections.triggerEmoji,
        monitoredChannels: slackConnections.monitoredChannels,
        createdAt: slackConnections.createdAt,
      })
      .from(slackConnections)
      .where(eq(slackConnections.teamId, teamId));

    if (connections.length === 0) {
      return { connection: null };
    }

    return { connection: connections[0] };
  });

  /**
   * PATCH /api/slack/connection?teamId=X — update Slack connection settings
   */
  app.patch('/connection', { preHandler: [requireRole({ minimumRole: 'admin', source: 'request' })] }, async (request, reply) => {
    const { teamId } = request.query as { teamId?: string };

    if (!teamId) {
      reply.code(400);
      return { error: 'teamId is required' };
    }

    const body = request.body as { triggerEmoji?: string; monitoredChannels?: string[] } | null;
    if (!body) {
      reply.code(400);
      return { error: 'Request body is required' };
    }

    const updates: Record<string, unknown> = {};
    if (body.triggerEmoji !== undefined) updates.triggerEmoji = body.triggerEmoji;
    if (body.monitoredChannels !== undefined) updates.monitoredChannels = body.monitoredChannels;

    if (Object.keys(updates).length === 0) {
      reply.code(400);
      return { error: 'No fields to update' };
    }

    await db
      .update(slackConnections)
      .set(updates)
      .where(eq(slackConnections.teamId, teamId));

    // Return updated connection
    const connections = await db
      .select({
        id: slackConnections.id,
        slackTeamId: slackConnections.slackTeamId,
        triggerEmoji: slackConnections.triggerEmoji,
        monitoredChannels: slackConnections.monitoredChannels,
        createdAt: slackConnections.createdAt,
      })
      .from(slackConnections)
      .where(eq(slackConnections.teamId, teamId));

    return { connection: connections[0] ?? null };
  });

  /**
   * DELETE /api/slack/connection?teamId=X — disconnect Slack
   */
  app.delete('/connection', { preHandler: [requireRole({ minimumRole: 'admin', source: 'request' })] }, async (request, reply) => {
    const { teamId } = request.query as { teamId?: string };

    if (!teamId) {
      reply.code(400);
      return { error: 'teamId is required' };
    }

    await db
      .delete(slackConnections)
      .where(eq(slackConnections.teamId, teamId));

    return { disconnected: true };
  });
};
