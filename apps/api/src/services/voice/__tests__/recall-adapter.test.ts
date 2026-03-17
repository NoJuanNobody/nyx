import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AudioStreamEvent } from '@nyx/shared';
import type { CallPlatformAdapter } from '../call-integration.types.js';

// Mock fetch globally before importing the module
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Set the env var before importing the adapter
vi.stubEnv('RECALL_AI_API_KEY', 'test-api-key-123');

const {
  recallZoomAdapter,
  recallGoogleMeetAdapter,
  recallTeamsAdapter,
} = await import('../recall-adapter.js');

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function textResponse(text: string, status: number): Response {
  return new Response(text, { status });
}

describe('recall-adapter', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Platform identity ──────────────────────────────────────

  describe('platform identity', () => {
    it('recallZoomAdapter has platform "zoom"', () => {
      expect(recallZoomAdapter.platform).toBe('zoom');
    });

    it('recallGoogleMeetAdapter has platform "google_meet"', () => {
      expect(recallGoogleMeetAdapter.platform).toBe('google_meet');
    });

    it('recallTeamsAdapter has platform "teams"', () => {
      expect(recallTeamsAdapter.platform).toBe('teams');
    });

    it('all adapters implement CallPlatformAdapter', () => {
      const adapters: CallPlatformAdapter[] = [
        recallZoomAdapter,
        recallGoogleMeetAdapter,
        recallTeamsAdapter,
      ];
      for (const adapter of adapters) {
        expect(adapter).toHaveProperty('platform');
        expect(adapter).toHaveProperty('connect');
        expect(typeof adapter.connect).toBe('function');
      }
    });
  });

  // ── connect — bot creation ─────────────────────────────────

  describe('connect', () => {
    it('creates a bot via POST and waits for in_call status', async () => {
      // POST /bot -> create bot
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ id: 'bot-1', status: { code: 'joining_call' } }),
      );
      // GET /bot/bot-1 -> still joining
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ id: 'bot-1', status: { code: 'joining_call' } }),
      );
      // GET /bot/bot-1 -> in call
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ id: 'bot-1', status: { code: 'in_call_recording' } }),
      );

      const connection = await recallZoomAdapter.connect({
        platform: 'zoom',
        meetingUrl: 'https://zoom.us/j/123456',
      });

      expect(mockFetch).toHaveBeenCalledTimes(3);

      // Verify POST body
      const [createUrl, createInit] = mockFetch.mock.calls[0];
      expect(createUrl).toBe('https://api.recall.ai/api/v1/bot');
      expect(createInit.method).toBe('POST');
      expect(JSON.parse(createInit.body)).toMatchObject({
        meeting_url: 'https://zoom.us/j/123456',
      });

      // Verify auth header
      expect(createInit.headers.Authorization).toBe('Token test-api-key-123');

      expect(typeof connection.disconnect).toBe('function');
      expect(typeof connection.onAudio).toBe('function');

      // Clean up
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 200));
      await connection.disconnect();
    });

    it('throws when bot creation API returns an error', async () => {
      mockFetch.mockResolvedValueOnce(
        textResponse('Unauthorized', 401),
      );

      await expect(
        recallZoomAdapter.connect({
          platform: 'zoom',
          meetingUrl: 'https://zoom.us/j/123456',
        }),
      ).rejects.toThrow('Recall.ai bot creation failed (401)');
    });

    it('throws when bot reaches a terminal failure status', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ id: 'bot-fail', status: { code: 'joining_call' } }),
      );
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ id: 'bot-fail', status: { code: 'fatal' } }),
      );

      await expect(
        recallGoogleMeetAdapter.connect({
          platform: 'google_meet',
          meetingUrl: 'https://meet.google.com/abc-def',
        }),
      ).rejects.toThrow('terminal status "fatal"');
    });

    it('throws when bot status check API fails', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ id: 'bot-err', status: { code: 'joining_call' } }),
      );
      mockFetch.mockResolvedValueOnce(
        textResponse('Internal Server Error', 500),
      );

      await expect(
        recallTeamsAdapter.connect({
          platform: 'teams',
          meetingUrl: 'https://teams.microsoft.com/l/meetup-join/abc',
        }),
      ).rejects.toThrow('bot status check failed (500)');
    });
  });

  // ── connect — transcript polling ───────────────────────────

  describe('transcript polling', () => {
    async function connectWithMocks(): Promise<{
      connection: Awaited<ReturnType<CallPlatformAdapter['connect']>>;
    }> {
      // POST /bot
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ id: 'bot-tx', status: { code: 'joining_call' } }),
      );
      // GET /bot/bot-tx -> in call immediately
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ id: 'bot-tx', status: { code: 'in_call_recording' } }),
      );

      const connection = await recallZoomAdapter.connect({
        platform: 'zoom',
        meetingUrl: 'https://zoom.us/j/999',
      });

      return { connection };
    }

    it('forwards new transcript entries as audio_chunk events', async () => {
      const { connection } = await connectWithMocks();

      const events: AudioStreamEvent[] = [];
      connection.onAudio((e) => events.push(e));

      // Mock the transcript poll response
      mockFetch.mockResolvedValueOnce(
        jsonResponse([
          {
            speaker: 'Alice',
            words: [
              { text: 'Hello', start_timestamp: 1.0, end_timestamp: 1.5 },
              { text: 'world', start_timestamp: 1.5, end_timestamp: 2.0 },
            ],
          },
        ]),
      );

      // Advance time to trigger transcript poll
      await vi.advanceTimersByTimeAsync(3_500);

      expect(events.length).toBe(1);
      expect(events[0]).toMatchObject({
        type: 'audio_chunk',
        data: 'Hello world',
        speakerId: 'Alice',
        timestampMs: 1000,
      });

      // Clean up
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 200));
      await connection.disconnect();
    });

    it('only emits events for new transcript entries', async () => {
      const { connection } = await connectWithMocks();

      const events: AudioStreamEvent[] = [];
      connection.onAudio((e) => {
        if (e.type === 'audio_chunk') events.push(e);
      });

      // First poll: 1 entry
      mockFetch.mockResolvedValueOnce(
        jsonResponse([
          {
            speaker: 'Alice',
            words: [{ text: 'Hi', start_timestamp: 1.0, end_timestamp: 1.5 }],
          },
        ]),
      );

      await vi.advanceTimersByTimeAsync(3_500);
      expect(events.length).toBe(1);

      // Second poll: same entry plus a new one
      mockFetch.mockResolvedValueOnce(
        jsonResponse([
          {
            speaker: 'Alice',
            words: [{ text: 'Hi', start_timestamp: 1.0, end_timestamp: 1.5 }],
          },
          {
            speaker: 'Bob',
            words: [{ text: 'Hey', start_timestamp: 2.0, end_timestamp: 2.5 }],
          },
        ]),
      );

      await vi.advanceTimersByTimeAsync(3_500);
      expect(events.length).toBe(2);
      expect(events[1]).toMatchObject({
        type: 'audio_chunk',
        data: 'Hey',
        speakerId: 'Bob',
      });

      // Clean up
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 200));
      await connection.disconnect();
    });

    it('handles transcript poll errors gracefully without crashing', async () => {
      const { connection } = await connectWithMocks();

      const events: AudioStreamEvent[] = [];
      connection.onAudio((e) => {
        if (e.type === 'audio_chunk') events.push(e);
      });

      // First poll fails
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      await vi.advanceTimersByTimeAsync(3_500);
      expect(events.length).toBe(0); // no crash, no events

      // Second poll succeeds
      mockFetch.mockResolvedValueOnce(
        jsonResponse([
          {
            speaker: 'Alice',
            words: [{ text: 'Hello', start_timestamp: 1.0, end_timestamp: 1.5 }],
          },
        ]),
      );

      await vi.advanceTimersByTimeAsync(3_500);
      expect(events.length).toBe(1);

      // Clean up
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 200));
      await connection.disconnect();
    });

    it('handles transcript 404 gracefully (returns empty)', async () => {
      const { connection } = await connectWithMocks();

      const events: AudioStreamEvent[] = [];
      connection.onAudio((e) => {
        if (e.type === 'audio_chunk') events.push(e);
      });

      // Transcript endpoint returns 404
      mockFetch.mockResolvedValueOnce(textResponse('Not Found', 404));

      await vi.advanceTimersByTimeAsync(3_500);
      expect(events.length).toBe(0);

      // Clean up
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 200));
      await connection.disconnect();
    });
  });

  // ── disconnect ─────────────────────────────────────────────

  describe('disconnect', () => {
    async function connectBot(): Promise<
      Awaited<ReturnType<CallPlatformAdapter['connect']>>
    > {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ id: 'bot-dc', status: { code: 'joining_call' } }),
      );
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ id: 'bot-dc', status: { code: 'in_call_not_recording' } }),
      );
      return recallZoomAdapter.connect({
        platform: 'zoom',
        meetingUrl: 'https://zoom.us/j/456',
      });
    }

    it('calls leave_call endpoint and emits end event', async () => {
      const connection = await connectBot();

      const events: AudioStreamEvent[] = [];
      connection.onAudio((e) => events.push(e));

      mockFetch.mockResolvedValueOnce(jsonResponse({}, 200));
      await connection.disconnect();

      // Verify leave_call was called
      const leaveCall = mockFetch.mock.calls.find(
        ([url]: [string]) =>
          typeof url === 'string' && url.includes('/leave_call'),
      );
      expect(leaveCall).toBeDefined();
      expect(leaveCall![0]).toBe(
        'https://api.recall.ai/api/v1/bot/bot-dc/leave_call',
      );
      expect(leaveCall![1].method).toBe('POST');

      // Should have received an end event
      expect(events.some((e) => e.type === 'end')).toBe(true);
    });

    it('is idempotent — calling disconnect twice does not error', async () => {
      const connection = await connectBot();

      mockFetch.mockResolvedValueOnce(jsonResponse({}, 200));
      await connection.disconnect();
      await connection.disconnect(); // should not throw or call API again

      // leave_call should only be called once
      const leaveCalls = mockFetch.mock.calls.filter(
        ([url]: [string]) =>
          typeof url === 'string' && url.includes('/leave_call'),
      );
      expect(leaveCalls.length).toBe(1);
    });

    it('handles 404 from leave_call gracefully (bot already left)', async () => {
      const connection = await connectBot();

      mockFetch.mockResolvedValueOnce(textResponse('Not Found', 404));
      await expect(connection.disconnect()).resolves.not.toThrow();
    });

    it('throws when leave_call returns a non-404 error', async () => {
      const connection = await connectBot();

      mockFetch.mockResolvedValueOnce(textResponse('Server Error', 500));
      await expect(connection.disconnect()).rejects.toThrow(
        'bot removal failed (500)',
      );
    });
  });

  // ── Missing API key ────────────────────────────────────────

  describe('missing API key', () => {
    it('throws a clear error when RECALL_AI_API_KEY is not set', async () => {
      const originalKey = process.env.RECALL_AI_API_KEY;
      delete process.env.RECALL_AI_API_KEY;

      try {
        await expect(
          recallZoomAdapter.connect({
            platform: 'zoom',
            meetingUrl: 'https://zoom.us/j/123',
          }),
        ).rejects.toThrow('RECALL_AI_API_KEY environment variable is not set');
      } finally {
        process.env.RECALL_AI_API_KEY = originalKey;
      }
    });
  });
});
