import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { CallState } from '@nyx/shared';
import type { AudioStreamEvent } from '@nyx/shared';
import { callIntegrationService } from '../services/voice/call-integration.service.js';
import { meetingIntelligenceService } from '../services/voice/meeting-intelligence.service.js';
import { voiceAgentService } from '../services/voice/voice-agent.service.js';

// ── Bot ID ↔ Session ID mapping ────────────────────────────────────

const botSessionMap = new Map<string, string>();

/**
 * Register a mapping from a Recall.ai bot ID to an internal session ID.
 * Called by the Recall adapter when a bot is created.
 */
export function registerBotSession(botId: string, sessionId: string): void {
  botSessionMap.set(botId, sessionId);
}

/**
 * Look up the internal session ID for a given Recall.ai bot ID.
 */
export function getSessionForBot(botId: string): string | undefined {
  return botSessionMap.get(botId);
}

/**
 * Get the most recently registered session ID (fallback for payloads without bot_id).
 */
export function getLatestSession(): string | undefined {
  const entries = [...botSessionMap.values()];
  return entries.length > 0 ? entries[entries.length - 1] : undefined;
}

/**
 * Clear bot-session mappings (for testing).
 */
export function _resetBotSessions(): void {
  botSessionMap.clear();
}

// ── Status mapping ─────────────────────────────────────────────────

const RECALL_STATUS_MAP: Record<string, CallState> = {
  joining: 'connecting',
  in_meeting: 'in_call',
  done: 'ended',
  fatal: 'error',
};

// ── Webhook signature verification ─────────────────────────────────

function verifyWebhookSignature(
  rawBody: string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature) return false;

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const signatureBuffer = Buffer.from(signature, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');

  if (signatureBuffer.length !== expectedBuffer.length) return false;

  return timingSafeEqual(signatureBuffer, expectedBuffer);
}

// ── Recall.ai webhook types ────────────────────────────────────────

interface RecallTranscriptWord {
  text: string;
  start_time?: number;
  end_time?: number;
  start_timestamp?: { relative: number; absolute: string };
  end_timestamp?: { relative: number; absolute: string };
  speaker_id?: number;
  speaker?: string;
}

interface RecallWebhookPayload {
  event: string;
  data: {
    bot_id?: string;
    status?: { code: string };
    transcript?: {
      words: RecallTranscriptWord[];
      is_final: boolean;
    };
    // Real-time transcript format: data.data.words
    data?: {
      words: RecallTranscriptWord[];
      is_final?: boolean;
      speaker?: string;
    };
  };
}

// ── Route plugin ───────────────────────────────────────────────────

export const voiceWebhookRoutes: FastifyPluginAsync = async (fastify) => {
  // Add raw body content type parser for signature verification
  fastify.addContentTypeParser(
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

  // HEAD handler for webhook endpoint verification (Recall.ai pings this)
  fastify.head('/webhooks/recall', async (_request, reply) => {
    return reply.status(200).send();
  });

  fastify.post<{
    Body: RecallWebhookPayload;
    Headers: { 'x-recall-signature'?: string };
  }>('/webhooks/recall', async (request, reply) => {
    const webhookSecret = process.env.RECALL_AI_WEBHOOK_SECRET;
    if (webhookSecret) {
      const signature = request.headers['x-recall-signature'] as string | undefined;
      const rawBodyStr =
        typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
      if (!verifyWebhookSignature(rawBodyStr, signature, webhookSecret)) {
        return reply.status(401).send({ error: 'Invalid webhook signature' });
      }
    }
    const rawBody = request.body as unknown as Record<string, unknown>;

    const { event, data } = request.body;
    const botId = data?.bot_id ?? (rawBody as any).bot_id;

    if (!event) {
      return reply.status(400).send({ error: 'Missing event' });
    }

    // Look up session by bot_id, or fall back to most recent active session
    let sessionId = botId ? getSessionForBot(botId) : undefined;
    if (!sessionId && !botId) {
      // For real-time transcript events that don't include bot_id,
      // find the most recent registered session
      sessionId = getLatestSession();
    }

    // Handle event types
    if (event === 'bot.status_change') {
      const statusCode = data.status?.code;
      if (!statusCode) {
        return reply.status(200).send({ ok: true });
      }

      const mappedState = RECALL_STATUS_MAP[statusCode];
      if (!mappedState) {
        request.log.warn(
          { statusCode, botId: data.bot_id },
          'Unknown Recall.ai status code, ignoring',
        );
        return reply.status(200).send({ ok: true });
      }

      if (sessionId) {
        try {
          callIntegrationService.updateSessionState(sessionId, mappedState);
        } catch (err) {
          request.log.error(
            { err, sessionId, state: mappedState },
            'Failed to update session state',
          );
        }
      } else {
        request.log.warn(
          { botId: data.bot_id },
          'No session found for bot, status change ignored',
        );
      }
    } else if (event === 'bot.transcription' || event === 'transcript.data') {
      // Handle both payload formats: data.transcript.words (legacy) and data.data.words (real-time)
      const words = data.transcript?.words ?? data.data?.words;
      const speaker = data.data?.speaker ?? words?.[0]?.speaker ?? words?.[0]?.speaker_id?.toString() ?? 'Unknown';

      if (words && words.length > 0) {
        const text = words.map((w: RecallTranscriptWord) => w.text).join(' ');
        const speakerId = speaker;

        if (text.trim()) {
          // Feed transcript to voice agent via the event bus
          if (sessionId) {
            voiceAgentService.feedTranscript(sessionId, speakerId, text);
          }

          try {
            if (sessionId) {
              await meetingIntelligenceService.processTranscript(sessionId, text);
            }
          } catch (err) {
            request.log.error(
              { err, sessionId },
              'Failed to process transcript from webhook',
            );
          }
        }
      }
    } else {
      request.log.info({ event, botId: data.bot_id }, 'Unhandled Recall.ai event');
    }

    // Always return 200 quickly (webhook best practice)
    return reply.status(200).send({ ok: true });
  });
};
