import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { CallState, AudioStreamEvent } from '@nyx/shared';
import type {
  CallSessionInternal,
  JoinCallConfig,
  CallLifecycleEvent,
  CallPlatformAdapter,
} from './call-integration.types.js';
import { VALID_TRANSITIONS } from './call-integration.types.js';

/** In-memory session store (Map-based for MVP). */
const sessions = new Map<string, CallSessionInternal>();

/** Map of sessionId -> platform adapter disconnect function */
const activeConnections = new Map<string, { disconnect: () => Promise<void> }>();

/** Map of platform name -> adapter instance */
const adapters = new Map<string, CallPlatformAdapter>();

/** Central event bus for call lifecycle events. */
const eventBus = new EventEmitter();
eventBus.setMaxListeners(100);

function assertValidTransition(current: CallState, next: CallState): void {
  const allowed = VALID_TRANSITIONS[current];
  if (!allowed.includes(next)) {
    throw new Error(
      `Invalid state transition: cannot move from "${current}" to "${next}"`,
    );
  }
}

function transitionState(sessionId: string, next: CallState): CallSessionInternal {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Unknown session: ${sessionId}`);
  }

  assertValidTransition(session.state, next);

  const from = session.state;
  session.state = next;

  if (next === 'ended' || next === 'error') {
    session.endedAt = new Date().toISOString();
  }

  const event: CallLifecycleEvent = {
    type: 'state_change',
    sessionId,
    from,
    to: next,
  };
  eventBus.emit('lifecycle', event);

  return session;
}

/**
 * Stub adapter used for testing and development.
 * Simulates connecting, streaming silence, and disconnecting.
 */
export const stubAdapter: CallPlatformAdapter = {
  platform: 'zoom',

  async connect(_config: JoinCallConfig) {
    const audioHandlers: Array<(event: AudioStreamEvent) => void> = [];
    let interval: ReturnType<typeof setInterval> | undefined;

    // Simulate periodic silence frames
    interval = setInterval(() => {
      const event: AudioStreamEvent = {
        type: 'silence',
        timestampMs: Date.now(),
      };
      for (const handler of audioHandlers) {
        handler(event);
      }
    }, 1000);

    return {
      async disconnect() {
        if (interval) {
          clearInterval(interval);
          interval = undefined;
        }
      },
      onAudio(handler: (event: AudioStreamEvent) => void) {
        audioHandlers.push(handler);
      },
    };
  },
};

export const callIntegrationService = {
  /**
   * Register a platform adapter for use when joining calls.
   */
  registerAdapter(adapter: CallPlatformAdapter): void {
    adapters.set(adapter.platform, adapter);
  },

  /**
   * Join a call on the specified platform.
   * Returns the created session.
   */
  async joinCall(config: JoinCallConfig): Promise<CallSessionInternal> {
    const adapter = adapters.get(config.platform);
    if (!adapter) {
      throw new Error(
        `No adapter registered for platform "${config.platform}". ` +
          `Available: ${[...adapters.keys()].join(', ') || 'none'}`,
      );
    }

    const sessionId = randomUUID();
    const session: CallSessionInternal = {
      id: sessionId,
      platform: config.platform,
      state: 'idle',
      meetingUrl: config.meetingUrl,
      startedAt: new Date().toISOString(),
    };
    sessions.set(sessionId, session);

    // idle -> connecting
    transitionState(sessionId, 'connecting');

    try {
      const connection = await adapter.connect(config);

      // Forward audio events through the event bus
      connection.onAudio((audioEvent) => {
        const lifecycleEvent: CallLifecycleEvent = {
          type: 'audio',
          sessionId,
          event: audioEvent,
        };
        eventBus.emit('lifecycle', lifecycleEvent);
      });

      activeConnections.set(sessionId, connection);

      // connecting -> in_call
      transitionState(sessionId, 'in_call');

      return sessions.get(sessionId)!;
    } catch (err) {
      // connecting -> error
      const errorMsg = err instanceof Error ? err.message : 'Unknown connection error';
      try {
        transitionState(sessionId, 'error');
      } catch {
        // If transition fails, force error state
        session.state = 'error';
        session.endedAt = new Date().toISOString();
      }

      const errorEvent: CallLifecycleEvent = {
        type: 'error',
        sessionId,
        error: errorMsg,
      };
      eventBus.emit('lifecycle', errorEvent);

      throw new Error(`Failed to join call: ${errorMsg}`);
    }
  },

  /**
   * Leave an active call session.
   */
  async leaveCall(sessionId: string): Promise<CallSessionInternal> {
    const session = sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }

    // in_call -> disconnecting
    transitionState(sessionId, 'disconnecting');

    const connection = activeConnections.get(sessionId);
    if (connection) {
      try {
        await connection.disconnect();
      } catch {
        // Best-effort disconnect
      }
      activeConnections.delete(sessionId);
    }

    // disconnecting -> ended
    transitionState(sessionId, 'ended');

    return sessions.get(sessionId)!;
  },

  /**
   * Get the current status of a call session.
   */
  getStatus(sessionId: string): CallSessionInternal | undefined {
    return sessions.get(sessionId);
  },

  /**
   * Subscribe to lifecycle events for a specific session.
   * Returns an unsubscribe function.
   */
  onLifecycleEvent(
    sessionId: string,
    handler: (event: CallLifecycleEvent) => void,
  ): () => void {
    const listener = (event: CallLifecycleEvent) => {
      if ('sessionId' in event && event.sessionId === sessionId) {
        handler(event);
      }
    };
    eventBus.on('lifecycle', listener);
    return () => {
      eventBus.off('lifecycle', listener);
    };
  },

  /**
   * Clear all sessions (for testing).
   */
  _reset(): void {
    for (const [id, conn] of activeConnections.entries()) {
      conn.disconnect().catch(() => {});
      activeConnections.delete(id);
    }
    sessions.clear();
    adapters.clear();
    eventBus.removeAllListeners();
  },
};
