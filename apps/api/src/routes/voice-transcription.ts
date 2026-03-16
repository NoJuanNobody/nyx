import type { FastifyPluginAsync } from 'fastify';
import multipart from '@fastify/multipart';
import { meetingIntelligenceService } from '../services/voice/meeting-intelligence.service.js';
import { semanticParserService } from '../services/voice/semantic-parser.service.js';
import { transcriptionService } from '../services/transcription.service.js';

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB

export const voiceTranscriptionRoutes: FastifyPluginAsync = async (app) => {
  // Register multipart support for audio uploads in this plugin scope
  await app.register(multipart, {
    limits: { fileSize: MAX_FILE_SIZE },
  });

  /**
   * POST /api/voice/transcribe
   * Accept { transcript: string, sessionId?: string } as JSON body
   * OR an audio file upload (multipart/form-data with optional sessionId field).
   * Returns MeetingIntelligence.
   */
  app.post('/transcribe', async (request, reply) => {
    const contentType = request.headers['content-type'] || '';

    // Handle multipart audio upload
    if (contentType.includes('multipart/form-data')) {
      const data = await request.file();
      if (!data) {
        reply.code(400);
        return { error: 'No file uploaded. Please attach an audio file.' };
      }

      const buffer = await data.toBuffer();
      const filename = data.filename;
      const mimeType = data.mimetype;

      const validation = transcriptionService.validateAudioFile(
        filename,
        mimeType,
        buffer.length,
      );
      if (!validation.valid) {
        reply.code(400);
        return { error: validation.error };
      }

      const sessionId =
        (data.fields?.sessionId as { value?: string } | undefined)?.value ||
        meetingIntelligenceService.generateSessionId();

      try {
        const intelligence = await meetingIntelligenceService.processAudioBuffer(
          sessionId,
          buffer,
          mimeType,
        );
        return intelligence;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Processing failed';
        reply.code(422);
        return { error: `Transcription processing failed: ${message}` };
      }
    }

    // Handle JSON body with transcript text
    const body = request.body as { transcript?: string; sessionId?: string } | null;
    if (!body?.transcript || typeof body.transcript !== 'string') {
      reply.code(400);
      return {
        error: 'Request must include a "transcript" string field or an audio file upload.',
      };
    }

    const sessionId = body.sessionId || meetingIntelligenceService.generateSessionId();

    try {
      const intelligence = await meetingIntelligenceService.processTranscript(
        sessionId,
        body.transcript,
      );
      return intelligence;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Processing failed';
      reply.code(422);
      return { error: `Transcript processing failed: ${message}` };
    }
  });

  /**
   * GET /api/voice/intelligence/:sessionId
   * Return stored MeetingIntelligence for a session.
   */
  app.get('/intelligence/:sessionId', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };

    const intelligence = meetingIntelligenceService.getIntelligence(sessionId);
    if (!intelligence) {
      reply.code(404);
      return { error: `No intelligence found for session ${sessionId}` };
    }

    return intelligence;
  });

  /**
   * POST /api/voice/parse
   * Accept { transcript: string } and return just the parsed entities (no storage).
   */
  app.post('/parse', async (request, reply) => {
    const body = request.body as { transcript?: string } | null;
    if (!body?.transcript || typeof body.transcript !== 'string') {
      reply.code(400);
      return { error: 'Request must include a "transcript" string field.' };
    }

    try {
      const parsed = await semanticParserService.parseTranscript(body.transcript);
      return parsed;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Parsing failed';
      reply.code(422);
      return { error: `Transcript parsing failed: ${message}` };
    }
  });
};
