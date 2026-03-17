import type { MeetingPlatform, AudioStreamEvent } from '@nyx/shared';
import type { CallPlatformAdapter, JoinCallConfig } from './call-integration.types.js';

const RECALL_API_BASE = 'https://api.recall.ai/api/v1';

/** How often (ms) to poll bot status while waiting for it to join the meeting. */
const STATUS_POLL_INTERVAL_MS = 2_000;

/** Maximum time (ms) to wait for a bot to reach "in_call" status. */
const STATUS_POLL_TIMEOUT_MS = 120_000;

/** How often (ms) to poll for new transcript entries once the bot is in the call. */
const TRANSCRIPT_POLL_INTERVAL_MS = 3_000;

/** Bot statuses that indicate the bot is actively in the meeting. */
const IN_CALL_STATUSES = new Set(['in_call_not_recording', 'in_call_recording']);

/** Bot statuses that indicate a terminal failure. */
const TERMINAL_FAILURE_STATUSES = new Set([
  'fatal',
  'done',
  'media_expired',
  'analysis_failed',
]);

interface RecallBotResponse {
  id: string;
  status: { code: string };
}

interface RecallTranscriptEntry {
  speaker: string;
  words: Array<{ text: string; start_timestamp: number; end_timestamp: number }>;
}

function getApiKey(): string {
  const key = process.env.RECALL_AI_API_KEY;
  if (!key) {
    throw new Error(
      'RECALL_AI_API_KEY environment variable is not set. ' +
        'A Recall.ai API key is required to create meeting bots.',
    );
  }
  return key;
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Token ${getApiKey()}`,
    'Content-Type': 'application/json',
  };
}

async function createBot(meetingUrl: string): Promise<RecallBotResponse> {
  const response = await fetch(`${RECALL_API_BASE}/bot`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      meeting_url: meetingUrl,
      transcription_options: { provider: 'default' },
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => 'unknown error');
    throw new Error(
      `Recall.ai bot creation failed (${response.status}): ${body}`,
    );
  }

  return (await response.json()) as RecallBotResponse;
}

async function getBotStatus(botId: string): Promise<RecallBotResponse> {
  const response = await fetch(`${RECALL_API_BASE}/bot/${botId}`, {
    headers: authHeaders(),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => 'unknown error');
    throw new Error(
      `Recall.ai bot status check failed (${response.status}): ${body}`,
    );
  }

  return (await response.json()) as RecallBotResponse;
}

async function getTranscript(botId: string): Promise<RecallTranscriptEntry[]> {
  const response = await fetch(`${RECALL_API_BASE}/bot/${botId}/transcript`, {
    headers: authHeaders(),
  });

  if (!response.ok) {
    // Transcript may not be available yet — return empty rather than throwing
    return [];
  }

  return (await response.json()) as RecallTranscriptEntry[];
}

async function removeBot(botId: string): Promise<void> {
  const response = await fetch(`${RECALL_API_BASE}/bot/${botId}/leave_call`, {
    method: 'POST',
    headers: authHeaders(),
  });

  // Accept 200-299 and 404 (bot already left)
  if (!response.ok && response.status !== 404) {
    const body = await response.text().catch(() => 'unknown error');
    throw new Error(
      `Recall.ai bot removal failed (${response.status}): ${body}`,
    );
  }
}

/**
 * Wait for the Recall.ai bot to reach an in-call status.
 * Throws if the bot reaches a terminal failure state or the timeout expires.
 */
async function waitForBotInCall(
  botId: string,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + STATUS_POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new Error('Bot status polling aborted');
    }

    const bot = await getBotStatus(botId);
    const statusCode = bot.status.code;

    if (IN_CALL_STATUSES.has(statusCode)) {
      return;
    }

    if (TERMINAL_FAILURE_STATUSES.has(statusCode)) {
      throw new Error(
        `Recall.ai bot reached terminal status "${statusCode}" before joining the call`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_INTERVAL_MS));
  }

  throw new Error(
    `Recall.ai bot did not join the call within ${STATUS_POLL_TIMEOUT_MS / 1000}s`,
  );
}

/**
 * Creates a CallPlatformAdapter backed by the Recall.ai REST API.
 * A single factory is used for all three platforms since Recall.ai handles
 * platform differences internally based on the meeting URL.
 */
function createRecallAdapter(platform: MeetingPlatform): CallPlatformAdapter {
  return {
    platform,

    async connect(config: JoinCallConfig) {
      const bot = await createBot(config.meetingUrl);
      const botId = bot.id;

      const abortController = new AbortController();
      const audioHandlers: Array<(event: AudioStreamEvent) => void> = [];
      let transcriptPollTimer: ReturnType<typeof setInterval> | undefined;
      let lastTranscriptLength = 0;
      let disconnected = false;

      // Wait for bot to join the meeting
      await waitForBotInCall(botId, abortController.signal);

      // Start polling for transcript data
      transcriptPollTimer = setInterval(async () => {
        if (disconnected) return;

        try {
          const entries = await getTranscript(botId);

          // Only process new entries since last poll
          if (entries.length > lastTranscriptLength) {
            const newEntries = entries.slice(lastTranscriptLength);
            lastTranscriptLength = entries.length;

            for (const entry of newEntries) {
              const text = entry.words.map((w) => w.text).join(' ');
              const timestampMs =
                entry.words.length > 0
                  ? Math.round(entry.words[0].start_timestamp * 1000)
                  : Date.now();

              const event: AudioStreamEvent = {
                type: 'audio_chunk',
                data: text,
                speakerId: entry.speaker,
                timestampMs,
              };

              for (const handler of audioHandlers) {
                handler(event);
              }
            }
          }
        } catch {
          // Transcript polling errors are non-fatal; we'll retry next interval
        }
      }, TRANSCRIPT_POLL_INTERVAL_MS);

      return {
        async disconnect() {
          if (disconnected) return;
          disconnected = true;

          abortController.abort();

          if (transcriptPollTimer) {
            clearInterval(transcriptPollTimer);
            transcriptPollTimer = undefined;
          }

          // Send end event to all handlers
          const endEvent: AudioStreamEvent = {
            type: 'end',
            timestampMs: Date.now(),
          };
          for (const handler of audioHandlers) {
            handler(endEvent);
          }

          await removeBot(botId);
        },

        onAudio(handler: (event: AudioStreamEvent) => void) {
          audioHandlers.push(handler);
        },
      };
    },
  };
}

/** Recall.ai adapter for Zoom meetings. */
export const recallZoomAdapter: CallPlatformAdapter = createRecallAdapter('zoom');

/** Recall.ai adapter for Google Meet meetings. */
export const recallGoogleMeetAdapter: CallPlatformAdapter = createRecallAdapter('google_meet');

/** Recall.ai adapter for Microsoft Teams meetings. */
export const recallTeamsAdapter: CallPlatformAdapter = createRecallAdapter('teams');
