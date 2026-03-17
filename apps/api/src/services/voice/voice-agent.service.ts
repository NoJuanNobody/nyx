import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../lib/config.js';
import type { AudioStreamEvent } from '@nyx/shared';
import { callIntegrationService } from './call-integration.service.js';
import type { CallLifecycleEvent } from './call-integration.types.js';

const MODEL = 'claude-sonnet-4-20250514';

const client = config.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })
  : null;

function requireClient(): Anthropic {
  if (!client) {
    throw new Error(
      'ANTHROPIC_API_KEY is not configured. Voice agent requires a valid API key.',
    );
  }
  return client;
}

const SYSTEM_PROMPT = `You are Nyx, an AI meeting assistant participating in a live call. Your job is to be helpful, concise, and natural.

Behavior:
- Only respond when someone addresses you by name ("Nyx", "hey Nyx", etc.) or asks a direct question to the bot.
- Keep responses SHORT — 1-3 sentences max. This is spoken aloud via TTS, not written text.
- Be conversational and natural. Avoid bullet points, markdown, or formal structure.
- If asked to take notes, confirm briefly. You are already capturing the transcript.
- If asked about something said earlier in the meeting, reference the transcript context.
- If you don't know something, say so briefly.
- Never interrupt or respond to conversation not directed at you.
- Do NOT respond with empty messages or filler.

If the conversation does not mention you or ask you anything, respond with exactly: __SKIP__`;

interface AgentState {
  sessionId: string;
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
  transcriptBuffer: string[];
  unsubscribe: () => void;
  processing: boolean;
  stopped: boolean;
}

const activeAgents = new Map<string, AgentState>();

/** Minimum characters of new transcript before triggering the agent. */
const MIN_BUFFER_LENGTH = 20;

/** How long to wait after last transcript before processing (debounce). */
const DEBOUNCE_MS = 3_000;

function stripCodeFences(text: string): string {
  return text
    .replace(/```(?:json)?\s*\n?/g, '')
    .replace(/\n?\s*```/g, '')
    .trim();
}

async function processTranscript(state: AgentState): Promise<void> {
  if (state.processing || state.stopped) return;
  if (state.transcriptBuffer.length === 0) return;

  const bufferedText = state.transcriptBuffer.join('\n');
  if (bufferedText.length < MIN_BUFFER_LENGTH) return;

  state.processing = true;
  state.transcriptBuffer = [];

  try {
    const ai = requireClient();

    // Add new transcript as user message
    state.conversationHistory.push({
      role: 'user',
      content: `[Meeting transcript]\n${bufferedText}`,
    });

    // Keep conversation history manageable (last 40 messages)
    if (state.conversationHistory.length > 40) {
      state.conversationHistory = state.conversationHistory.slice(-40);
    }

    const response = await ai.messages.create({
      model: MODEL,
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      messages: state.conversationHistory,
    });

    let text = response.content[0].type === 'text' ? response.content[0].text : '';
    text = stripCodeFences(text).trim();

    if (text && text !== '__SKIP__') {
      state.conversationHistory.push({ role: 'assistant', content: text });

      // Send response via chat into the call
      try {
        await callIntegrationService.sendChat(state.sessionId, text);
      } catch {
        // Session may have ended
      }

      console.log(`[VoiceAgent:${state.sessionId.slice(0, 8)}] Response: ${text}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[VoiceAgent:${state.sessionId.slice(0, 8)}] Error: ${msg}`);
  } finally {
    state.processing = false;
  }
}

export const voiceAgentService = {
  /**
   * Start the voice agent loop for a given session.
   * Listens to transcript events and responds when addressed.
   */
  start(sessionId: string): void {
    if (activeAgents.has(sessionId)) {
      console.log(`[VoiceAgent] Agent already running for session ${sessionId.slice(0, 8)}`);
      return;
    }

    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    const state: AgentState = {
      sessionId,
      conversationHistory: [],
      transcriptBuffer: [],
      unsubscribe: () => {},
      processing: false,
      stopped: false,
    };

    const unsubscribe = callIntegrationService.onLifecycleEvent(
      sessionId,
      (event: CallLifecycleEvent) => {
        // Buffer incoming transcript chunks
        if (event.type === 'audio' && 'event' in event) {
          const audioEvent = event.event as AudioStreamEvent;
          if (audioEvent.type === 'audio_chunk' && audioEvent.data) {
            const speaker = audioEvent.speakerId ?? 'Unknown';
            state.transcriptBuffer.push(`${speaker}: ${audioEvent.data}`);

            // Debounce: wait for a pause in speech before processing
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
              processTranscript(state).catch(() => {});
            }, DEBOUNCE_MS);
          }
        }

        // Stop agent when call ends
        if (
          event.type === 'state_change' &&
          (event.to === 'ended' || event.to === 'error')
        ) {
          voiceAgentService.stop(sessionId);
        }
      },
    );

    state.unsubscribe = unsubscribe;
    activeAgents.set(sessionId, state);

    console.log(`[VoiceAgent] Started for session ${sessionId.slice(0, 8)}`);
  },

  /**
   * Stop the voice agent loop for a given session.
   */
  stop(sessionId: string): void {
    const state = activeAgents.get(sessionId);
    if (!state) return;

    state.stopped = true;
    state.unsubscribe();
    activeAgents.delete(sessionId);

    console.log(`[VoiceAgent] Stopped for session ${sessionId.slice(0, 8)}`);
  },

  /**
   * Feed transcript data directly into the agent (from webhooks).
   */
  feedTranscript(sessionId: string, speaker: string, text: string): void {
    const state = activeAgents.get(sessionId);
    if (!state || state.stopped) return;

    state.transcriptBuffer.push(`${speaker}: ${text}`);
    console.log(`[VoiceAgent:${sessionId.slice(0, 8)}] Transcript: ${speaker}: ${text}`);

    // Debounce processing
    if ((state as any)._debounceTimer) clearTimeout((state as any)._debounceTimer);
    (state as any)._debounceTimer = setTimeout(() => {
      processTranscript(state).catch(() => {});
    }, DEBOUNCE_MS);
  },

  /**
   * Check if an agent is running for a session.
   */
  isRunning(sessionId: string): boolean {
    return activeAgents.has(sessionId);
  },
};
