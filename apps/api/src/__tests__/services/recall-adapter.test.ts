import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────

let capturedFetchBody: Record<string, unknown> | null = null;

const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
  const urlStr = String(url);

  // Bot creation endpoint — capture the request body
  if (urlStr.endsWith('/bot') && init?.method === 'POST') {
    capturedFetchBody = JSON.parse(init.body as string);
    return {
      ok: true,
      json: async () => ({ id: 'bot-123', status: { code: 'ready' } }),
    };
  }

  // Bot status endpoint — return in_call immediately
  if (urlStr.includes('/bot/bot-123') && !urlStr.includes('/')) {
    return {
      ok: true,
      json: async () => ({ id: 'bot-123', status: { code: 'in_call_recording' } }),
    };
  }

  // Default: status check returns in_call
  if (urlStr.match(/\/bot\/bot-123$/)) {
    return {
      ok: true,
      json: async () => ({ id: 'bot-123', status: { code: 'in_call_recording' } }),
    };
  }

  // Transcript endpoint
  if (urlStr.includes('/transcript')) {
    return { ok: true, json: async () => [] };
  }

  // Leave call
  if (urlStr.includes('/leave_call')) {
    return { ok: true };
  }

  // output_audio
  if (urlStr.includes('/output_audio')) {
    return { ok: true };
  }

  // send_chat_message
  if (urlStr.includes('/send_chat_message')) {
    return { ok: true };
  }

  return { ok: true, json: async () => ({}) };
});

vi.stubGlobal('fetch', mockFetch);

// ── Env setup ─────────────────────────────────────────────────────

vi.stubEnv('RECALL_AI_API_KEY', 'test-recall-key');
vi.stubEnv('RECALL_WEBHOOK_URL', 'https://example.com/webhooks/recall');

// Avoid side-effect of registerBotSession import
vi.mock('../../routes/voice-webhooks.js', () => ({
  registerBotSession: vi.fn(),
}));

// ── Import after mocks ─────────────────────────────────────────────

const { recallZoomAdapter } = await import(
  '../../services/voice/recall-adapter.js'
);

// ── Tests ──────────────────────────────────────────────────────────

describe('recall-adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedFetchBody = null;
  });

  describe('bot creation', () => {
    it('includes output_audio TTS configuration', async () => {
      const connection = await recallZoomAdapter.connect({
        platform: 'zoom',
        meetingUrl: 'https://zoom.us/j/123456',
        sessionId: 'session-tts',
      });

      expect(capturedFetchBody).not.toBeNull();
      expect(capturedFetchBody!.output_audio).toEqual({
        tts: {
          provider: 'default',
        },
      });

      await connection.disconnect();
    });

    it('includes chat greeting on bot join', async () => {
      const connection = await recallZoomAdapter.connect({
        platform: 'zoom',
        meetingUrl: 'https://zoom.us/j/123456',
        sessionId: 'session-chat',
      });

      expect(capturedFetchBody).not.toBeNull();
      expect(capturedFetchBody!.chat).toEqual({
        on_bot_join: {
          send_to: 'everyone',
          message: 'Nyx AI assistant has joined.',
        },
      });

      await connection.disconnect();
    });

    it('includes output_media configuration', async () => {
      const connection = await recallZoomAdapter.connect({
        platform: 'zoom',
        meetingUrl: 'https://zoom.us/j/123456',
        sessionId: 'session-media',
      });

      expect(capturedFetchBody).not.toBeNull();
      expect(capturedFetchBody!.output_media).toEqual({
        camera: { kind: 'default' },
        speaker: { kind: 'default' },
      });

      await connection.disconnect();
    });

    it('includes webhook transcript configuration when RECALL_WEBHOOK_URL is set', async () => {
      const connection = await recallZoomAdapter.connect({
        platform: 'zoom',
        meetingUrl: 'https://zoom.us/j/123456',
        sessionId: 'session-webhook',
      });

      expect(capturedFetchBody).not.toBeNull();
      expect(capturedFetchBody!.recording_config).toBeDefined();
      const recordingConfig = capturedFetchBody!.recording_config as Record<string, unknown>;
      expect(recordingConfig.realtime_endpoints).toBeDefined();

      await connection.disconnect();
    });
  });
});
