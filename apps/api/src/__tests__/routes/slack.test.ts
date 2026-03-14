import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDb, mockFetch } from '../helpers/setup.js';
import { createHmac } from 'node:crypto';
import Fastify from 'fastify';
import { slackRoutes } from '../../routes/slack.js';

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: async () => {},
}));

vi.mock('../../lib/config.js', () => ({
  config: {
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    PORT: 3001,
    HOST: '0.0.0.0',
    NODE_ENV: 'test',
    SLACK_CLIENT_ID: 'test-slack-client-id',
    SLACK_CLIENT_SECRET: 'test-slack-client-secret',
    SLACK_SIGNING_SECRET: undefined, // Not set so signature verification is skipped in tests
  },
}));

vi.mock('../../services/slack.service.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/slack.service.js')>(
    '../../services/slack.service.js',
  );
  return {
    ...actual,
    slackService: {
      verifySlackSignature: actual.verifySlackSignature,
      processSlackMessage: vi.fn().mockResolvedValue({ summary: 'processed', source: 'slack' }),
      sendSlackResponse: vi.fn().mockResolvedValue(undefined),
    },
  };
});

const SIGNING_SECRET = 'test-signing-secret';

function slackSign(timestamp: string, body: string): string {
  const sigBasestring = `v0:${timestamp}:${body}`;
  return 'v0=' + createHmac('sha256', SIGNING_SECRET).update(sigBasestring).digest('hex');
}

async function buildSlackApp() {
  const app = Fastify({ logger: false });
  app.decorateRequest('user', null as any);
  app.register(slackRoutes, { prefix: '/api/slack' });
  await app.ready();
  return app;
}

describe('Slack Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /api/slack/events — url_verification', () => {
    it('responds with the challenge token', async () => {
      const app = await buildSlackApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/slack/events',
        headers: { 'content-type': 'application/json' },
        payload: { type: 'url_verification', challenge: 'test-challenge-token' },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ challenge: 'test-challenge-token' });
    });
  });

  describe('POST /api/slack/events — event_callback', () => {
    it('acknowledges a message event with 200', async () => {
      // Mock finding a Slack connection
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            {
              id: 'conn-1',
              teamId: 'team-1',
              slackTeamId: 'T123',
              triggerEmoji: 'nyx',
              monitoredChannels: ['C999'],
            },
          ]),
        }),
      } as unknown);

      const app = await buildSlackApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/slack/events',
        headers: { 'content-type': 'application/json' },
        payload: {
          type: 'event_callback',
          team_id: 'T123',
          event: {
            type: 'message',
            text: 'some message',
            user: 'U456',
            channel: 'C999',
          },
        },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ ok: true });
    });

    it('acknowledges reaction_added event with 200', async () => {
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            {
              id: 'conn-1',
              teamId: 'team-1',
              slackTeamId: 'T123',
              triggerEmoji: 'nyx',
              monitoredChannels: [],
            },
          ]),
        }),
      } as unknown);

      const app = await buildSlackApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/slack/events',
        headers: { 'content-type': 'application/json' },
        payload: {
          type: 'event_callback',
          team_id: 'T123',
          event: {
            type: 'reaction_added',
            reaction: 'nyx',
            user: 'U456',
            item_user: 'U789',
            item: { type: 'message', channel: 'C999', ts: '123' },
          },
        },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ ok: true });
    });

    it('handles missing connection gracefully', async () => {
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as unknown);

      const app = await buildSlackApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/slack/events',
        headers: { 'content-type': 'application/json' },
        payload: {
          type: 'event_callback',
          team_id: 'T_UNKNOWN',
          event: { type: 'message', text: 'hello', user: 'U1', channel: 'C1' },
        },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ ok: true });
    });
  });

  describe('POST /api/slack/command', () => {
    it('processes slash command and returns ephemeral response', async () => {
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { id: 'conn-1', teamId: 'team-1', slackTeamId: 'T123' },
          ]),
        }),
      } as unknown);

      const app = await buildSlackApp();
      const body = 'text=hello+world&team_id=T123&user_id=U456&channel_id=C789&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2Fxyz';

      const res = await app.inject({
        method: 'POST',
        url: '/api/slack/command',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: body,
      });

      expect(res.statusCode).toBe(200);
      const parsed = JSON.parse(res.payload);
      expect(parsed.response_type).toBe('ephemeral');
      expect(parsed.text).toContain('hello world');
    });

    it('returns info message when workspace is not connected', async () => {
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as unknown);

      const app = await buildSlackApp();
      const body = 'text=test&team_id=T_UNKNOWN&user_id=U1&channel_id=C1';

      const res = await app.inject({
        method: 'POST',
        url: '/api/slack/command',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: body,
      });

      expect(res.statusCode).toBe(200);
      const parsed = JSON.parse(res.payload);
      expect(parsed.response_type).toBe('ephemeral');
      expect(parsed.text).toContain('not connected');
    });
  });

  describe('GET /api/slack/install', () => {
    it('returns a Slack OAuth URL', async () => {
      const app = await buildSlackApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/slack/install?teamId=team-1',
      });

      expect(res.statusCode).toBe(200);
      const parsed = JSON.parse(res.payload);
      expect(parsed.url).toContain('slack.com/oauth/v2/authorize');
      expect(parsed.url).toContain('client_id=');
    });

    it('returns 400 if teamId is missing', async () => {
      const app = await buildSlackApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/slack/install',
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/slack/callback', () => {
    it('exchanges code for token and redirects to settings', async () => {
      // Mock Slack OAuth response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          ok: true,
          access_token: 'xoxb-test-token',
          team: { id: 'T_NEW' },
        }),
        text: vi.fn().mockResolvedValue(''),
        status: 200,
        statusText: 'OK',
      });

      // Mock DB: no existing connection
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as unknown);

      mockDb.insert.mockReturnValue({
        values: vi.fn().mockResolvedValue([]),
      } as unknown);

      const app = await buildSlackApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/slack/callback?code=test-code&state=team-1',
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain('/settings');
    });

    it('returns 400 if code is missing', async () => {
      const app = await buildSlackApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/slack/callback?state=team-1',
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/slack/connection', () => {
    it('returns connection when found', async () => {
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            {
              id: 'conn-1',
              slackTeamId: 'T123',
              triggerEmoji: 'nyx',
              monitoredChannels: ['C1'],
              createdAt: '2026-01-01',
            },
          ]),
        }),
      } as unknown);

      const app = await buildSlackApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/slack/connection?teamId=team-1',
      });

      expect(res.statusCode).toBe(200);
      const parsed = JSON.parse(res.payload);
      expect(parsed.connection).toBeTruthy();
      expect(parsed.connection.slackTeamId).toBe('T123');
    });

    it('returns null when no connection exists', async () => {
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as unknown);

      const app = await buildSlackApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/slack/connection?teamId=team-1',
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ connection: null });
    });

    it('returns 400 if teamId is missing', async () => {
      const app = await buildSlackApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/slack/connection',
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('DELETE /api/slack/connection', () => {
    it('disconnects and returns success', async () => {
      mockDb.delete.mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      } as unknown);

      const app = await buildSlackApp();
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/slack/connection?teamId=team-1',
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ disconnected: true });
    });
  });

  describe('PATCH /api/slack/connection', () => {
    it('updates trigger emoji', async () => {
      mockDb.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as unknown);

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            {
              id: 'conn-1',
              slackTeamId: 'T123',
              triggerEmoji: 'rocket',
              monitoredChannels: [],
              createdAt: '2026-01-01',
            },
          ]),
        }),
      } as unknown);

      const app = await buildSlackApp();
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/slack/connection?teamId=team-1',
        headers: { 'content-type': 'application/json' },
        payload: { triggerEmoji: 'rocket' },
      });

      expect(res.statusCode).toBe(200);
      const parsed = JSON.parse(res.payload);
      expect(parsed.connection).toBeTruthy();
    });
  });
});
