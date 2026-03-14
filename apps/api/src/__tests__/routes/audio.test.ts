import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDb } from '../helpers/setup.js';
import Fastify from 'fastify';
import { audioRoutes } from '../../routes/audio.js';

const mockTranscriptionService = vi.hoisted(() => ({
  validateAudioFile: vi.fn(),
  transcribeAudio: vi.fn(),
  structureTranscript: vi.fn(),
}));

vi.mock('../../services/transcription.service.js', () => ({
  transcriptionService: mockTranscriptionService,
}));

vi.mock('../../middleware/permissions.js', () => ({
  requireRole: () => async () => {},
}));

async function buildApp() {
  const app = Fastify({ logger: false });
  app.decorateRequest('user', null as any);
  app.addHook('preHandler', async (request) => {
    request.user = {
      id: 'user-1',
      clerkId: 'clerk_1',
      email: 'test@test.com',
      name: 'Test User',
      avatarUrl: null,
      role: 'admin',
    } as any;
  });
  app.register(audioRoutes, { prefix: '/api/intake' });
  await app.ready();
  return app;
}

function createMultipartPayload(filename: string, mimeType: string, content: string) {
  const boundary = '----FormBoundary123';
  const body =
    `------FormBoundary123\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n` +
    `${content}\r\n` +
    `------FormBoundary123--\r\n`;

  return {
    body,
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
  };
}

describe('Audio Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /api/intake/audio', () => {
    it('returns 400 when no file is uploaded', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/intake/audio',
        headers: { 'content-type': 'multipart/form-data; boundary=----FormBoundary123' },
        body: '------FormBoundary123--\r\n',
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain('No file');
    });

    it('returns 400 when file validation fails', async () => {
      mockTranscriptionService.validateAudioFile.mockReturnValue({
        valid: false,
        error: 'Unsupported file extension ".txt"',
      });

      const app = await buildApp();
      const { body, headers } = createMultipartPayload('notes.txt', 'text/plain', 'hello');
      const res = await app.inject({
        method: 'POST',
        url: '/api/intake/audio',
        headers,
        body,
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain('Unsupported');
    });

    it('returns transcript and structured spec on success', async () => {
      mockTranscriptionService.validateAudioFile.mockReturnValue({ valid: true });
      mockTranscriptionService.transcribeAudio.mockResolvedValue({
        transcript: 'We need a login page.',
      });
      mockTranscriptionService.structureTranscript.mockResolvedValue({
        title: 'Login Feature',
        content: '# Login Feature\n\n- Login page with email/password',
      });

      const app = await buildApp();
      const { body, headers } = createMultipartPayload('memo.mp3', 'audio/mpeg', 'fakeaudiodata');
      const res = await app.inject({
        method: 'POST',
        url: '/api/intake/audio',
        headers,
        body,
      });
      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.transcript).toBe('We need a login page.');
      expect(json.structured.title).toBe('Login Feature');
    });

    it('returns 422 when transcription fails', async () => {
      mockTranscriptionService.validateAudioFile.mockReturnValue({ valid: true });
      mockTranscriptionService.transcribeAudio.mockRejectedValue(new Error('Audio unclear'));

      const app = await buildApp();
      const { body, headers } = createMultipartPayload('memo.mp3', 'audio/mpeg', 'fakedata');
      const res = await app.inject({
        method: 'POST',
        url: '/api/intake/audio',
        headers,
        body,
      });
      expect(res.statusCode).toBe(422);
      expect(JSON.parse(res.body).error).toContain('Transcription failed');
    });

    it('returns transcript with fallback when structuring fails', async () => {
      mockTranscriptionService.validateAudioFile.mockReturnValue({ valid: true });
      mockTranscriptionService.transcribeAudio.mockResolvedValue({
        transcript: 'Raw text here',
      });
      mockTranscriptionService.structureTranscript.mockRejectedValue(new Error('AI error'));

      const app = await buildApp();
      const { body, headers } = createMultipartPayload('memo.mp3', 'audio/mpeg', 'fakedata');
      const res = await app.inject({
        method: 'POST',
        url: '/api/intake/audio',
        headers,
        body,
      });
      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.transcript).toBe('Raw text here');
      expect(json.structured.content).toBe('Raw text here');
    });
  });

  describe('POST /api/intake/transcript', () => {
    it('returns 400 when no transcript provided', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/intake/transcript',
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain('transcript is required');
    });

    it('returns 400 for empty transcript', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/intake/transcript',
        payload: { transcript: '   ' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns structured spec from pasted transcript', async () => {
      mockTranscriptionService.structureTranscript.mockResolvedValue({
        title: 'Meeting Notes',
        content: '# Meeting Notes\n\nDiscussed the roadmap.',
      });

      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/intake/transcript',
        payload: { transcript: 'We discussed the roadmap for Q2.' },
      });
      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.transcript).toBe('We discussed the roadmap for Q2.');
      expect(json.structured.title).toBe('Meeting Notes');
    });
  });
});
