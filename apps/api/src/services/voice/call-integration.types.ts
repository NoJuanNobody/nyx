import type { CallState, MeetingPlatform, AudioStreamEvent, BotOutputEvent } from '@nyx/shared';

export interface CallSessionInternal {
  id: string;
  platform: MeetingPlatform;
  state: CallState;
  meetingUrl: string;
  startedAt: string;
  endedAt?: string;
}

export interface JoinCallConfig {
  platform: MeetingPlatform;
  meetingUrl: string;
  authToken?: string;
  sessionId?: string;
}

export type CallLifecycleEvent =
  | { type: 'state_change'; sessionId: string; from: CallState; to: CallState }
  | { type: 'error'; sessionId: string; error: string }
  | { type: 'audio'; sessionId: string; event: AudioStreamEvent }
  | { type: 'bot_output'; sessionId: string; event: BotOutputEvent };

export interface CallPlatformAdapter {
  readonly platform: MeetingPlatform;

  /**
   * Connect to the meeting and begin streaming audio.
   * Returns a cleanup function to disconnect.
   */
  connect(config: JoinCallConfig): Promise<{
    disconnect: () => Promise<void>;
    onAudio: (handler: (event: AudioStreamEvent) => void) => void;
    sendChat: (message: string) => Promise<void>;
    speak: (message: string) => Promise<void>;
  }>;
}

/** Valid state transitions for the call lifecycle state machine. */
export const VALID_TRANSITIONS: Record<CallState, CallState[]> = {
  idle: ['connecting'],
  connecting: ['in_call', 'error', 'ended'],
  in_call: ['disconnecting', 'error', 'ended'],
  disconnecting: ['ended', 'error'],
  ended: [],
  error: ['connecting', 'ended'],
};
