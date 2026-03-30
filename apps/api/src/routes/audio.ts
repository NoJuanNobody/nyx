import type { FastifyPluginAsync } from 'fastify';
import multipart from '@fastify/multipart';
import { transcriptionService } from '../services/transcription.service.js';

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB

export const audioRoutes: FastifyPluginAsync = async (app) => {
  // Register multipart support for this plugin scope
  await app.register(multipart, {
    limits: {
      fileSize: MAX_FILE_SIZE,
    },
  });

  // POST /api/intake/audio — upload audio file, transcribe, and structure into a spec
  app.post('/audio', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const data = await request.file();

    if (!data) {
      reply.code(400);
      return { error: 'No file uploaded. Please attach an audio file.' };
    }

    const buffer = await data.toBuffer();
    const filename = data.filename;
    const mimeType = data.mimetype;

    // Validate the file
    const validation = transcriptionService.validateAudioFile(filename, mimeType, buffer.length);
    if (!validation.valid) {
      reply.code(400);
      return { error: validation.error };
    }

    // Transcribe the audio
    let transcript: string;
    try {
      const result = await transcriptionService.transcribeAudio(buffer, mimeType);
      transcript = result.transcript;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Transcription failed';
      reply.code(422);
      return {
        error: `Transcription failed: ${message}. You can paste the transcript manually instead.`,
      };
    }

    // Structure the transcript into a spec
    let structured: { title: string; content: string };
    try {
      structured = await transcriptionService.structureTranscript(transcript);
    } catch (err) {
      // Return the transcript even if structuring fails
      return {
        transcript,
        structured: {
          title: 'Untitled Transcript',
          content: transcript,
        },
      };
    }

    return {
      transcript,
      structured,
    };
  });

  // POST /api/intake/transcript — accept a pasted transcript and structure it
  app.post('/transcript', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { transcript } = request.body as { transcript?: string };

    if (!transcript || !transcript.trim()) {
      reply.code(400);
      return { error: 'transcript is required' };
    }

    const structured = await transcriptionService.structureTranscript(transcript.trim());

    return {
      transcript: transcript.trim(),
      structured,
    };
  });
};
