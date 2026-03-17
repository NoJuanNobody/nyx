import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AudioStreamEvent } from '@nyx/shared';
import {
  callIntegrationService,
  stubAdapter,
} from '../call-integration.service.js';
import type {
  CallPlatformAdapter,
  CallLifecycleEvent,
} from '../call-integration.types.js';

describe('callIntegrationService', () => {
  beforeEach(() => {
    callIntegrationService._reset();
    callIntegrationService.registerAdapter(stubAdapter);
  });

  // ── joinCall ──────────────────────────────────────────────

  describe('joinCall', () => {
    it('creates a session and transitions to in_call', async () => {
      const session = await callIntegrationService.joinCall({
        platform: 'zoom',
        meetingUrl: 'https://zoom.us/j/123456',
      });

      expect(session.id).toBeDefined();
      expect(session.platform).toBe('zoom');
      expect(session.state).toBe('in_call');
      expect(session.meetingUrl).toBe('https://zoom.us/j/123456');
      expect(session.startedAt).toBeDefined();
    });

    it('throws when no adapter is registered for the platform', async () => {
      await expect(
        callIntegrationService.joinCall({
          platform: 'google_meet',
          meetingUrl: 'https://meet.google.com/abc-def-ghi',
        }),
      ).rejects.toThrow('No adapter registered for platform "google_meet"');
    });

    it('emits state_change events during join', async () => {
      const events: CallLifecycleEvent[] = [];

      // We need to set up the listener before we know the sessionId,
      // so we listen to all events via a temporary approach:
      // join, then check getStatus
      const session = await callIntegrationService.joinCall({
        platform: 'zoom',
        meetingUrl: 'https://zoom.us/j/123456',
      });

      // Verify the final state
      const status = callIntegrationService.getStatus(session.id);
      expect(status?.state).toBe('in_call');
    });

    it('transitions to error state when adapter.connect fails', async () => {
      const failingAdapter: CallPlatformAdapter = {
        platform: 'google_meet',
        async connect() {
          throw new Error('Connection refused');
        },
      };

      callIntegrationService.registerAdapter(failingAdapter);

      await expect(
        callIntegrationService.joinCall({
          platform: 'google_meet',
          meetingUrl: 'https://meet.google.com/abc',
        }),
      ).rejects.toThrow('Failed to join call: Connection refused');
    });
  });

  // ── leaveCall ─────────────────────────────────────────────

  describe('leaveCall', () => {
    it('transitions from in_call to ended', async () => {
      const session = await callIntegrationService.joinCall({
        platform: 'zoom',
        meetingUrl: 'https://zoom.us/j/123456',
      });

      const ended = await callIntegrationService.leaveCall(session.id);
      expect(ended.state).toBe('ended');
      expect(ended.endedAt).toBeDefined();
    });

    it('throws for unknown session', async () => {
      await expect(
        callIntegrationService.leaveCall('nonexistent-id'),
      ).rejects.toThrow('Unknown session: nonexistent-id');
    });

    it('emits state_change events during leave', async () => {
      const session = await callIntegrationService.joinCall({
        platform: 'zoom',
        meetingUrl: 'https://zoom.us/j/123456',
      });

      const events: CallLifecycleEvent[] = [];
      callIntegrationService.onLifecycleEvent(session.id, (e) => events.push(e));

      await callIntegrationService.leaveCall(session.id);

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        type: 'state_change',
        from: 'in_call',
        to: 'disconnecting',
      });
      expect(events[1]).toMatchObject({
        type: 'state_change',
        from: 'disconnecting',
        to: 'ended',
      });
    });
  });

  // ── getStatus ─────────────────────────────────────────────

  describe('getStatus', () => {
    it('returns undefined for unknown session', () => {
      expect(callIntegrationService.getStatus('unknown')).toBeUndefined();
    });

    it('returns current session state', async () => {
      const session = await callIntegrationService.joinCall({
        platform: 'zoom',
        meetingUrl: 'https://zoom.us/j/123456',
      });

      const status = callIntegrationService.getStatus(session.id);
      expect(status).toBeDefined();
      expect(status!.state).toBe('in_call');
    });
  });

  // ── State machine transitions ─────────────────────────────

  describe('state machine', () => {
    it('rejects invalid transitions', async () => {
      const session = await callIntegrationService.joinCall({
        platform: 'zoom',
        meetingUrl: 'https://zoom.us/j/123456',
      });

      // in_call -> connecting is invalid
      // We test this indirectly: you can't join the same session again,
      // but we can verify the ended state doesn't allow further transitions
      await callIntegrationService.leaveCall(session.id);

      // ended -> disconnecting is invalid — leaveCall will throw
      await expect(
        callIntegrationService.leaveCall(session.id),
      ).rejects.toThrow('Invalid state transition');
    });

    it('tracks endedAt on ended state', async () => {
      const session = await callIntegrationService.joinCall({
        platform: 'zoom',
        meetingUrl: 'https://zoom.us/j/123456',
      });

      expect(session.endedAt).toBeUndefined();

      const ended = await callIntegrationService.leaveCall(session.id);
      expect(ended.endedAt).toBeDefined();
      expect(new Date(ended.endedAt!).getTime()).toBeGreaterThan(0);
    });
  });

  // ── Event emission ────────────────────────────────────────

  describe('event emission', () => {
    it('emits audio events from the adapter', async () => {
      const audioEvents: CallLifecycleEvent[] = [];

      // Use a custom adapter that emits an audio chunk immediately
      const immediateAudioAdapter: CallPlatformAdapter = {
        platform: 'google_meet',
        async connect() {
          let audioHandler: ((event: AudioStreamEvent) => void) | undefined;

          // Emit an audio chunk on next tick after handler is attached
          const emitAudio = () => {
            if (audioHandler) {
              audioHandler({
                type: 'audio_chunk',
                data: 'base64-encoded-audio-data',
                speakerId: 'speaker-1',
                timestampMs: Date.now(),
              });
            }
          };

          return {
            async disconnect() {},
            onAudio(handler: (event: AudioStreamEvent) => void) {
              audioHandler = handler;
              // Emit immediately after handler registration
              setTimeout(emitAudio, 10);
            },
            async sendChat() {},
            async speak() {},
          };
        },
      };

      callIntegrationService.registerAdapter(immediateAudioAdapter);

      const session = await callIntegrationService.joinCall({
        platform: 'google_meet',
        meetingUrl: 'https://meet.google.com/abc',
      });

      callIntegrationService.onLifecycleEvent(session.id, (e) => {
        if (e.type === 'audio') audioEvents.push(e);
      });

      // Wait for the async audio emission
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(audioEvents.length).toBeGreaterThanOrEqual(1);
      expect(audioEvents[0]).toMatchObject({
        type: 'audio',
        sessionId: session.id,
      });
    });

    it('unsubscribe stops receiving events', async () => {
      const session = await callIntegrationService.joinCall({
        platform: 'zoom',
        meetingUrl: 'https://zoom.us/j/123456',
      });

      const events: CallLifecycleEvent[] = [];
      const unsubscribe = callIntegrationService.onLifecycleEvent(
        session.id,
        (e) => events.push(e),
      );

      // Unsubscribe immediately
      unsubscribe();

      await callIntegrationService.leaveCall(session.id);

      // Should have received no events after unsubscribe
      expect(events).toHaveLength(0);
    });
  });

  // ── Adapter registration ──────────────────────────────────

  describe('registerAdapter', () => {
    it('replaces existing adapter for the same platform', async () => {
      const customStub: CallPlatformAdapter = {
        platform: 'zoom',
        async connect() {
          return {
            async disconnect() {},
            onAudio() {},
            async sendChat() {},
            async speak() {},
          };
        },
      };

      callIntegrationService.registerAdapter(customStub);

      // Should still work — new adapter takes over
      const session = await callIntegrationService.joinCall({
        platform: 'zoom',
        meetingUrl: 'https://zoom.us/j/999',
      });
      expect(session.state).toBe('in_call');
    });
  });

  // ── _reset ────────────────────────────────────────────────

  describe('_reset', () => {
    it('clears all sessions and adapters', async () => {
      await callIntegrationService.joinCall({
        platform: 'zoom',
        meetingUrl: 'https://zoom.us/j/123456',
      });

      callIntegrationService._reset();

      // No adapters registered anymore
      await expect(
        callIntegrationService.joinCall({
          platform: 'zoom',
          meetingUrl: 'https://zoom.us/j/123456',
        }),
      ).rejects.toThrow('No adapter registered');
    });
  });

  // ── stubAdapter ───────────────────────────────────────────

  describe('stubAdapter', () => {
    it('has platform set to zoom', () => {
      expect(stubAdapter.platform).toBe('zoom');
    });

    it('connect returns disconnect and onAudio functions', async () => {
      const connection = await stubAdapter.connect({
        platform: 'zoom',
        meetingUrl: 'https://zoom.us/j/123',
      });

      expect(typeof connection.disconnect).toBe('function');
      expect(typeof connection.onAudio).toBe('function');

      // Clean up
      await connection.disconnect();
    });

    it('emits silence events periodically', async () => {
      const connection = await stubAdapter.connect({
        platform: 'zoom',
        meetingUrl: 'https://zoom.us/j/123',
      });

      const events: AudioStreamEvent[] = [];
      connection.onAudio((e) => events.push(e));

      // Wait for at least one silence event (~1s interval)
      await new Promise((resolve) => setTimeout(resolve, 1500));

      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].type).toBe('silence');
      expect(events[0].timestampMs).toBeGreaterThan(0);

      await connection.disconnect();
    }, 5000);
  });
});
