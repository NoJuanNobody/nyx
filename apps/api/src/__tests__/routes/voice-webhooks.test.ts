import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import Fastify from 'fastify';
import {
  voiceWebhookRoutes,
  registerBotSession,
  getSessionForBot,
  _resetBotSessions,
} from '../../routes/voice-webhooks.js';

// ── Mocks ──────────────────────────────────────────────────────────

const mockUpdateSessionState = vi.fn();
const mockProcessTranscript = vi.fn().mockResolvedValue({
  sessionId: 'session-1',
  transcript: [],
  decisions: [],
  actionItems: [],
  codeReferences: [],
  openQuestions: [],
  summary: '',
  duration: 0,
  participants: [],
  createdAt: new Date().toISOString(),
});

vi.mock('../../services/voice/call-integration.service.js', () => ({
  callIntegrationService: {
    updateSessionState: (...args: unknown[]) => mockUpdateSessionState(...args),
  },
}));

vi.mock('../../services/voice/meeting-intelligence.service.js', () => ({
  meetingIntelligenceService: {
    processTranscript: (...args: unknown[]) => mockProcessTranscript(...args),
  },
}));

// ── Helpers ────────────────────────────────────────────────────────

async function buildApp() {
  const app = Fastify({ logger: false });
  app.register(voiceWebhookRoutes, { prefix: '/api/voice' });
  await app.ready();
  return app;
}

function makePayload(event: string, data: Record<string, unknown>) {
  return { event, data };
}

function signPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

// ── Tests ──────────────────────────────────────────────────────────

describe('Voice Webhook Routes — POST /api/voice/webhooks/recall', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const originalEnv = process.env.RECALL_AI_WEBHOOK_SECRET;

  beforeEach(async () => {
    vi.clearAllMocks();
    _resetBotSessions();
    delete process.env.RECALL_AI_WEBHOOK_SECRET;
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    if (originalEnv !== undefined) {
      process.env.RECALL_AI_WEBHOOK_SECRET = originalEnv;
    } else {
      delete process.env.RECALL_AI_WEBHOOK_SECRET;
    }
  });

  // ── Bot session mapping ────────────────────────────────────────

  describe('registerBotSession / getSessionForBot', () => {
    it('stores and retrieves bot-to-session mapping', () => {
      registerBotSession('bot-abc', 'session-xyz');
      expect(getSessionForBot('bot-abc')).toBe('session-xyz');
    });

    it('returns undefined for unknown bot', () => {
      expect(getSessionForBot('unknown-bot')).toBeUndefined();
    });

    it('overwrites previous mapping for same bot', () => {
      registerBotSession('bot-1', 'session-old');
      registerBotSession('bot-1', 'session-new');
      expect(getSessionForBot('bot-1')).toBe('session-new');
    });
  });

  // ── Request validation ─────────────────────────────────────────

  describe('request validation', () => {
    it('rejects payload missing event field', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/voice/webhooks/recall',
        payload: { data: { bot_id: 'bot-1' } },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'Missing event or bot_id' });
    });

    it('rejects payload missing bot_id', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/voice/webhooks/recall',
        payload: { event: 'bot.status_change', data: {} },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'Missing event or bot_id' });
    });
  });

  // ── Signature verification ─────────────────────────────────────

  describe('webhook signature verification', () => {
    it('rejects request with invalid signature when secret is set', async () => {
      process.env.RECALL_AI_WEBHOOK_SECRET = 'test-secret';
      // Need a fresh app instance to pick up the env var
      await app.close();
      app = await buildApp();

      const payload = JSON.stringify(
        makePayload('bot.status_change', { bot_id: 'bot-1', status: { code: 'joining' } }),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/voice/webhooks/recall',
        payload,
        headers: {
          'content-type': 'application/json',
          'x-recall-signature': 'invalid-signature',
        },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'Invalid webhook signature' });
    });

    it('accepts request with valid signature when secret is set', async () => {
      process.env.RECALL_AI_WEBHOOK_SECRET = 'test-secret';
      await app.close();
      app = await buildApp();

      registerBotSession('bot-1', 'session-1');

      const payload = JSON.stringify(
        makePayload('bot.status_change', { bot_id: 'bot-1', status: { code: 'joining' } }),
      );
      const signature = signPayload(payload, 'test-secret');

      const res = await app.inject({
        method: 'POST',
        url: '/api/voice/webhooks/recall',
        payload,
        headers: {
          'content-type': 'application/json',
          'x-recall-signature': signature,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    });

    it('skips signature verification when secret is not set', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/voice/webhooks/recall',
        payload: makePayload('bot.status_change', {
          bot_id: 'bot-1',
          status: { code: 'joining' },
        }),
      });

      expect(res.statusCode).toBe(200);
    });
  });

  // ── bot.status_change ──────────────────────────────────────────

  describe('bot.status_change event', () => {
    it('maps "joining" to "connecting" and updates session', async () => {
      registerBotSession('bot-1', 'session-1');

      const res = await app.inject({
        method: 'POST',
        url: '/api/voice/webhooks/recall',
        payload: makePayload('bot.status_change', {
          bot_id: 'bot-1',
          status: { code: 'joining' },
        }),
      });

      expect(res.statusCode).toBe(200);
      expect(mockUpdateSessionState).toHaveBeenCalledWith('session-1', 'connecting');
    });

    it('maps "in_meeting" to "in_call"', async () => {
      registerBotSession('bot-2', 'session-2');

      await app.inject({
        method: 'POST',
        url: '/api/voice/webhooks/recall',
        payload: makePayload('bot.status_change', {
          bot_id: 'bot-2',
          status: { code: 'in_meeting' },
        }),
      });

      expect(mockUpdateSessionState).toHaveBeenCalledWith('session-2', 'in_call');
    });

    it('maps "done" to "ended"', async () => {
      registerBotSession('bot-3', 'session-3');

      await app.inject({
        method: 'POST',
        url: '/api/voice/webhooks/recall',
        payload: makePayload('bot.status_change', {
          bot_id: 'bot-3',
          status: { code: 'done' },
        }),
      });

      expect(mockUpdateSessionState).toHaveBeenCalledWith('session-3', 'ended');
    });

    it('maps "fatal" to "error"', async () => {
      registerBotSession('bot-4', 'session-4');

      await app.inject({
        method: 'POST',
        url: '/api/voice/webhooks/recall',
        payload: makePayload('bot.status_change', {
          bot_id: 'bot-4',
          status: { code: 'fatal' },
        }),
      });

      expect(mockUpdateSessionState).toHaveBeenCalledWith('session-4', 'error');
    });

    it('returns 200 for unknown status code without updating', async () => {
      registerBotSession('bot-5', 'session-5');

      const res = await app.inject({
        method: 'POST',
        url: '/api/voice/webhooks/recall',
        payload: makePayload('bot.status_change', {
          bot_id: 'bot-5',
          status: { code: 'unknown_status' },
        }),
      });

      expect(res.statusCode).toBe(200);
      expect(mockUpdateSessionState).not.toHaveBeenCalled();
    });

    it('returns 200 when no session found for bot', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/voice/webhooks/recall',
        payload: makePayload('bot.status_change', {
          bot_id: 'unknown-bot',
          status: { code: 'joining' },
        }),
      });

      expect(res.statusCode).toBe(200);
      expect(mockUpdateSessionState).not.toHaveBeenCalled();
    });

    it('returns 200 when status object is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/voice/webhooks/recall',
        payload: makePayload('bot.status_change', {
          bot_id: 'bot-1',
        }),
      });

      expect(res.statusCode).toBe(200);
      expect(mockUpdateSessionState).not.toHaveBeenCalled();
    });

    it('returns 200 even when updateSessionState throws', async () => {
      registerBotSession('bot-err', 'session-err');
      mockUpdateSessionState.mockImplementationOnce(() => {
        throw new Error('state transition failed');
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/voice/webhooks/recall',
        payload: makePayload('bot.status_change', {
          bot_id: 'bot-err',
          status: { code: 'joining' },
        }),
      });

      expect(res.statusCode).toBe(200);
    });
  });

  // ── bot.transcription ──────────────────────────────────────────

  describe('bot.transcription event', () => {
    it('extracts text from words and forwards to processTranscript', async () => {
      registerBotSession('bot-t1', 'session-t1');

      const res = await app.inject({
        method: 'POST',
        url: '/api/voice/webhooks/recall',
        payload: makePayload('bot.transcription', {
          bot_id: 'bot-t1',
          transcript: {
            words: [
              { text: 'Hello', start_time: 0, end_time: 0.5 },
              { text: 'world', start_time: 0.5, end_time: 1.0 },
            ],
            is_final: true,
          },
        }),
      });

      expect(res.statusCode).toBe(200);
      expect(mockProcessTranscript).toHaveBeenCalledWith('session-t1', 'Hello world');
    });

    it('skips empty transcript text', async () => {
      registerBotSession('bot-t2', 'session-t2');

      await app.inject({
        method: 'POST',
        url: '/api/voice/webhooks/recall',
        payload: makePayload('bot.transcription', {
          bot_id: 'bot-t2',
          transcript: {
            words: [{ text: '  ', start_time: 0, end_time: 0.1 }],
            is_final: true,
          },
        }),
      });

      expect(mockProcessTranscript).not.toHaveBeenCalled();
    });

    it('skips when no session found for bot', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/voice/webhooks/recall',
        payload: makePayload('bot.transcription', {
          bot_id: 'unknown-bot',
          transcript: {
            words: [{ text: 'test', start_time: 0, end_time: 0.5 }],
            is_final: true,
          },
        }),
      });

      expect(mockProcessTranscript).not.toHaveBeenCalled();
    });

    it('skips when transcript has no words', async () => {
      registerBotSession('bot-t3', 'session-t3');

      await app.inject({
        method: 'POST',
        url: '/api/voice/webhooks/recall',
        payload: makePayload('bot.transcription', {
          bot_id: 'bot-t3',
          transcript: { words: [], is_final: false },
        }),
      });

      // Empty words array produces empty string which is trimmed to empty
      expect(mockProcessTranscript).not.toHaveBeenCalled();
    });

    it('returns 200 even when processTranscript throws', async () => {
      registerBotSession('bot-t4', 'session-t4');
      mockProcessTranscript.mockRejectedValueOnce(new Error('processing failed'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/voice/webhooks/recall',
        payload: makePayload('bot.transcription', {
          bot_id: 'bot-t4',
          transcript: {
            words: [{ text: 'test', start_time: 0, end_time: 0.5 }],
            is_final: true,
          },
        }),
      });

      expect(res.statusCode).toBe(200);
    });
  });

  // ── Unknown events ─────────────────────────────────────────────

  describe('unknown events', () => {
    it('returns 200 for unhandled event types', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/voice/webhooks/recall',
        payload: makePayload('bot.something_else', { bot_id: 'bot-1' }),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(mockUpdateSessionState).not.toHaveBeenCalled();
      expect(mockProcessTranscript).not.toHaveBeenCalled();
    });
  });
});
