import { Command } from 'commander';
import { apiRequest, getBaseUrl } from '../lib/api.js';

interface VoiceSession {
  id: string;
  platform: string;
  meetingUrl: string;
  state: string;
  createdAt?: string;
}

interface JoinResponse {
  session: VoiceSession;
}

interface TranscribeResponse {
  sessionId: string;
  transcript?: string;
  actionItems?: Array<{ text: string; assignee?: string }>;
  decisions?: Array<{ text: string }>;
  summary?: string;
  [key: string]: unknown;
}

function detectPlatform(url: string): string {
  if (url.includes('zoom.us')) return 'zoom';
  if (url.includes('meet.google.com')) return 'google_meet';
  if (url.includes('teams.microsoft.com') || url.includes('teams.live.com'))
    return 'teams';
  return 'google_meet'; // default
}

export function registerVoiceCommand(program: Command): void {
  const voice = program
    .command('voice')
    .description('Voice and audio commands (join meetings, transcribe, TTS)');

  // ── nyx voice join ──────────────────────────────────────
  voice
    .command('join')
    .description('Join a meeting and start recording/transcription')
    .requiredOption('--url <meetingUrl>', 'Meeting URL (Google Meet, Zoom, or Teams)')
    .option('--platform <platform>', 'Platform override (zoom|google_meet|teams)')
    .option('--format <format>', 'Output format (json|pretty)', 'pretty')
    .action(
      async (opts: {
        url: string;
        platform?: string;
        format: string;
      }) => {
        const platform = opts.platform ?? detectPlatform(opts.url);

        try {
          const result = await apiRequest<JoinResponse>('/api/voice/join', {
            method: 'POST',
            body: JSON.stringify({
              platform,
              meetingUrl: opts.url,
            }),
          });

          if (opts.format === 'json') {
            console.log(JSON.stringify(result, null, 2));
          } else {
            const s = result.session;
            console.log('');
            console.log('  Joined meeting');
            console.log(`  Call ID:    ${s.id}`);
            console.log(`  Platform:   ${s.platform}`);
            console.log(`  State:      ${s.state}`);
            console.log(`  URL:        ${s.meetingUrl}`);
            console.log('');
            console.log(`  Use "nyx voice status ${s.id}" to check status`);
            console.log(`  Use "nyx voice transcript ${s.id}" to get transcript`);
            console.log('');
          }
        } catch (err) {
          console.error(
            'Error:',
            err instanceof Error ? err.message : String(err),
          );
          process.exit(1);
        }
      },
    );

  // ── nyx voice status ────────────────────────────────────
  voice
    .command('status')
    .description('Get the status of a voice call session')
    .argument('<call-id>', 'Call/session ID')
    .option('--format <format>', 'Output format (json|pretty)', 'pretty')
    .action(async (callId: string, opts: { format: string }) => {
      try {
        // The SSE endpoint returns text/event-stream; for a CLI one-shot
        // status check we fetch it and read the initial event.
        const baseUrl = getBaseUrl();
        const url = `${baseUrl}/api/voice/status/${encodeURIComponent(callId)}`;

        const headers: Record<string, string> = {};
        const apiKey = process.env.NYX_API_KEY;
        if (apiKey) {
          headers['Authorization'] = `Bearer ${apiKey}`;
        }

        const res = await fetch(url, { headers });

        if (!res.ok) {
          const body = await res.text();
          throw new Error(`API request failed (${res.status}): ${body}`);
        }

        const contentType = res.headers.get('content-type') ?? '';

        // If the response is SSE, read the first event
        if (contentType.includes('text/event-stream')) {
          const text = await res.text();
          const firstData = text
            .split('\n')
            .find((line) => line.startsWith('data: '));
          if (firstData) {
            const event = JSON.parse(firstData.replace('data: ', ''));
            if (opts.format === 'json') {
              console.log(JSON.stringify(event, null, 2));
            } else {
              console.log('');
              console.log(`  Call Status`);
              console.log(`  Session:  ${event.sessionId ?? callId}`);
              console.log(`  State:    ${event.to ?? event.state ?? 'unknown'}`);
              console.log('');
            }
          }
        } else {
          // JSON response
          const data = await res.json();
          if (opts.format === 'json') {
            console.log(JSON.stringify(data, null, 2));
          } else {
            const state =
              (data as Record<string, unknown>).state ??
              (data as Record<string, unknown>).status ??
              'unknown';
            console.log('');
            console.log(`  Call Status`);
            console.log(`  Session:  ${callId}`);
            console.log(`  State:    ${state}`);
            console.log('');
          }
        }
      } catch (err) {
        console.error(
          'Error:',
          err instanceof Error ? err.message : String(err),
        );
        process.exit(1);
      }
    });

  // ── nyx voice transcript ────────────────────────────────
  voice
    .command('transcript')
    .description('Get the transcript and meeting intelligence for a call')
    .argument('<call-id>', 'Call/session ID')
    .option('--format <format>', 'Output format (json|pretty)', 'pretty')
    .action(async (callId: string, opts: { format: string }) => {
      try {
        const result = await apiRequest<TranscribeResponse>(
          `/api/voice/intelligence/${encodeURIComponent(callId)}`,
        );

        if (opts.format === 'json') {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log('');
        console.log(`  Transcript for ${callId}`);
        console.log('  ' + '\u2500'.repeat(40));

        if (result.summary) {
          console.log('');
          console.log('  Summary:');
          console.log(`  ${result.summary}`);
        }

        if (result.transcript) {
          console.log('');
          console.log('  Transcript:');
          for (const line of result.transcript.split('\n')) {
            console.log(`  ${line}`);
          }
        }

        if (result.actionItems && result.actionItems.length > 0) {
          console.log('');
          console.log('  Action Items:');
          for (const item of result.actionItems) {
            const assignee = item.assignee ? ` (@${item.assignee})` : '';
            console.log(`    - ${item.text}${assignee}`);
          }
        }

        if (result.decisions && result.decisions.length > 0) {
          console.log('');
          console.log('  Decisions:');
          for (const d of result.decisions) {
            console.log(`    - ${d.text}`);
          }
        }

        console.log('');
      } catch (err) {
        console.error(
          'Error:',
          err instanceof Error ? err.message : String(err),
        );
        process.exit(1);
      }
    });
}
