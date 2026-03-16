import type { FastifyPluginAsync } from 'fastify';
import { MeetingPlatformSchema } from '@nyx/shared';
import {
  callIntegrationService,
  stubAdapter,
} from '../services/voice/call-integration.service.js';
import type { CallLifecycleEvent } from '../services/voice/call-integration.types.js';

// Register the stub adapter by default for MVP
callIntegrationService.registerAdapter(stubAdapter);

export const voiceRoutes: FastifyPluginAsync = async (fastify) => {
  // ── Join a call ─────────────────────────────────────────
  fastify.post<{
    Body: {
      platform: string;
      meetingUrl: string;
      authToken?: string;
    };
  }>('/join', async (request, reply) => {
    const { platform, meetingUrl, authToken } = request.body;

    const parsed = MeetingPlatformSchema.safeParse(platform);
    if (!parsed.success) {
      return reply.status(400).send({
        error: `Invalid platform "${platform}". Must be one of: zoom, google_meet, teams`,
      });
    }

    try {
      const session = await callIntegrationService.joinCall({
        platform: parsed.data,
        meetingUrl,
        authToken,
      });
      return reply.status(200).send({ session });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to join call';
      return reply.status(500).send({ error: message });
    }
  });

  // ── Leave a call ────────────────────────────────────────
  fastify.post<{
    Body: { sessionId: string };
  }>('/leave', async (request, reply) => {
    const { sessionId } = request.body;

    if (!sessionId) {
      return reply.status(400).send({ error: 'sessionId is required' });
    }

    try {
      const session = await callIntegrationService.leaveCall(sessionId);
      return reply.status(200).send({ session });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to leave call';
      const statusCode = message.includes('Unknown session') ? 404 : 500;
      return reply.status(statusCode).send({ error: message });
    }
  });

  // ── SSE status stream ───────────────────────────────────
  fastify.get<{
    Params: { sessionId: string };
  }>('/status/:sessionId', async (request, reply) => {
    const { sessionId } = request.params;

    const session = callIntegrationService.getStatus(sessionId);
    if (!session) {
      return reply.status(404).send({ error: `Unknown session: ${sessionId}` });
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // Send initial state
    reply.raw.write(
      `data: ${JSON.stringify({ type: 'state_change', sessionId, from: null, to: session.state })}\n\n`,
    );

    const unsubscribe = callIntegrationService.onLifecycleEvent(
      sessionId,
      (event: CallLifecycleEvent) => {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);

        // Close stream when call ends or errors
        if (
          event.type === 'state_change' &&
          (event.to === 'ended' || event.to === 'error')
        ) {
          unsubscribe();
          reply.raw.end();
        }
      },
    );

    // Clean up on client disconnect
    request.raw.on('close', () => {
      unsubscribe();
    });
  });
};
