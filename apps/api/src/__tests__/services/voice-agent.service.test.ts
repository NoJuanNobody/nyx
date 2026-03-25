import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────

const mockSpeak = vi.fn().mockResolvedValue(undefined);
const mockSendChat = vi.fn().mockResolvedValue(undefined);
const mockOnLifecycleEvent = vi.fn().mockReturnValue(() => {});

vi.mock('../../services/voice/call-integration.service.js', () => ({
  callIntegrationService: {
    speak: (...args: unknown[]) => mockSpeak(...args),
    sendChat: (...args: unknown[]) => mockSendChat(...args),
    onLifecycleEvent: (...args: unknown[]) => mockOnLifecycleEvent(...args),
  },
}));

const mockCreate = vi.fn().mockResolvedValue({
  content: [{ type: 'text', text: 'Hello from Nyx!' }],
});

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = { create: mockCreate };
    },
  };
});

vi.mock('../../lib/config.js', () => ({
  config: {
    ANTHROPIC_API_KEY: 'test-key-123',
  },
}));

// ── Import after mocks ─────────────────────────────────────────────

const { voiceAgentService } = await import(
  '../../services/voice/voice-agent.service.js'
);

// ── Tests ──────────────────────────────────────────────────────────

describe('voiceAgentService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('start', () => {
    it('registers a lifecycle listener for the session', () => {
      voiceAgentService.start('session-abc');
      expect(mockOnLifecycleEvent).toHaveBeenCalledWith(
        'session-abc',
        expect.any(Function),
      );
      voiceAgentService.stop('session-abc');
    });

    it('does not register twice for the same session', () => {
      voiceAgentService.start('session-dup');
      voiceAgentService.start('session-dup');
      expect(mockOnLifecycleEvent).toHaveBeenCalledTimes(1);
      voiceAgentService.stop('session-dup');
    });
  });

  describe('stop', () => {
    it('marks the agent as stopped', () => {
      voiceAgentService.start('session-stop');
      expect(voiceAgentService.isRunning('session-stop')).toBe(true);
      voiceAgentService.stop('session-stop');
      expect(voiceAgentService.isRunning('session-stop')).toBe(false);
    });

    it('is a no-op for unknown sessions', () => {
      expect(() => voiceAgentService.stop('nonexistent')).not.toThrow();
    });
  });

  describe('feedTranscript + processTranscript', () => {
    it('calls speak() (not sendChat()) when the AI responds', async () => {
      voiceAgentService.start('session-speak');

      // Feed enough transcript to exceed MIN_BUFFER_LENGTH
      voiceAgentService.feedTranscript(
        'session-speak',
        'Alice',
        'Hey Nyx, can you summarize what we discussed?',
      );

      // Advance past the debounce timer (3000ms)
      await vi.advanceTimersByTimeAsync(3_500);

      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(mockSpeak).toHaveBeenCalledWith('session-speak', 'Hello from Nyx!');
      expect(mockSendChat).not.toHaveBeenCalled();

      voiceAgentService.stop('session-speak');
    });

    it('does not speak when AI returns __SKIP__', async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: '__SKIP__' }],
      });

      voiceAgentService.start('session-skip');

      voiceAgentService.feedTranscript(
        'session-skip',
        'Bob',
        'So anyway, as I was saying about the quarterly results...',
      );

      await vi.advanceTimersByTimeAsync(3_500);

      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(mockSpeak).not.toHaveBeenCalled();
      expect(mockSendChat).not.toHaveBeenCalled();

      voiceAgentService.stop('session-skip');
    });

    it('logs an error when speak() fails instead of silently swallowing', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockSpeak.mockRejectedValueOnce(new Error('TTS provider unavailable'));

      voiceAgentService.start('session-err');

      voiceAgentService.feedTranscript(
        'session-err',
        'Carol',
        'Nyx, please take notes on this important discussion.',
      );

      await vi.advanceTimersByTimeAsync(3_500);

      expect(mockSpeak).toHaveBeenCalledTimes(1);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to speak: TTS provider unavailable'),
      );

      consoleSpy.mockRestore();
      voiceAgentService.stop('session-err');
    });

    it('ignores transcript for stopped sessions', () => {
      voiceAgentService.start('session-stopped');
      voiceAgentService.stop('session-stopped');

      voiceAgentService.feedTranscript(
        'session-stopped',
        'Dave',
        'Hey Nyx, are you there?',
      );

      // No AI call should happen
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('does not process when buffer is below minimum length', async () => {
      voiceAgentService.start('session-short');

      voiceAgentService.feedTranscript('session-short', 'Eve', 'Hi');

      await vi.advanceTimersByTimeAsync(3_500);

      expect(mockCreate).not.toHaveBeenCalled();

      voiceAgentService.stop('session-short');
    });
  });

  describe('isRunning', () => {
    it('returns true for active sessions', () => {
      voiceAgentService.start('session-run');
      expect(voiceAgentService.isRunning('session-run')).toBe(true);
      voiceAgentService.stop('session-run');
    });

    it('returns false for unknown sessions', () => {
      expect(voiceAgentService.isRunning('unknown')).toBe(false);
    });
  });
});
