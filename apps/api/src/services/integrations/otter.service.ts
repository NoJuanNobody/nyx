/**
 * Otter.ai transcription import service.
 *
 * Allows users to import Otter.ai transcriptions into the intake stage
 * of any pipeline. When OTTER_API_KEY is not set, stub methods return
 * mock data so the integration can be developed and tested without
 * a live Otter account.
 */

const OTTER_API_KEY = process.env.OTTER_API_KEY;

export interface OtterTranscript {
  id: string;
  title: string;
  createdAt: string;
  duration: number;
  summary: string | null;
}

export interface OtterTranscriptDetail extends OtterTranscript {
  text: string;
  speakers: string[];
}

export interface ImportTranscriptResult {
  documentId: string;
  appendedLength: number;
  formattedText: string;
}

/**
 * Format raw transcript text for intake, preserving speaker labels and timestamps.
 *
 * Otter transcripts typically arrive in a format like:
 *   Speaker 1  0:00
 *   Hello everyone, welcome to the meeting.
 *
 * This function wraps the text in a consistent markdown section so it
 * integrates cleanly into existing document content.
 */
export function formatTranscriptForIntake(transcriptText: string): string {
  const timestamp = new Date().toISOString();
  const lines = transcriptText.trim().split('\n');
  const formatted = lines
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return '';

      // Detect speaker label lines (e.g. "Speaker 1  0:00" or "John  1:23")
      const speakerMatch = trimmed.match(/^(.+?)\s{2,}(\d+:\d{2}(?::\d{2})?)$/);
      if (speakerMatch) {
        return `**${speakerMatch[1].trim()}** _(${speakerMatch[2]})_`;
      }

      return trimmed;
    })
    .join('\n');

  return [
    `## Otter.ai Transcript`,
    `_Imported on ${timestamp}_`,
    '',
    formatted,
  ].join('\n');
}

/**
 * Import a raw transcript into a document's content.
 *
 * The formatted transcript is appended to whatever content the document
 * already has, separated by a horizontal rule.
 */
export function importTranscript(
  transcriptText: string,
  existingContent: string,
): { content: string; formattedText: string } {
  if (!transcriptText.trim()) {
    throw new Error('Transcript text cannot be empty');
  }

  const formattedText = formatTranscriptForIntake(transcriptText);
  const separator = existingContent.trim() ? '\n\n---\n\n' : '';
  const content = `${existingContent}${separator}${formattedText}`;

  return { content, formattedText };
}

/**
 * List available transcripts from Otter.ai.
 * Returns mock data when OTTER_API_KEY is not configured.
 */
export async function listTranscripts(): Promise<OtterTranscript[]> {
  if (!OTTER_API_KEY) {
    return [
      {
        id: 'mock-transcript-1',
        title: 'Weekly Standup - Mar 18',
        createdAt: '2026-03-18T10:00:00Z',
        duration: 1800,
        summary: 'Team discussed sprint progress and blockers.',
      },
      {
        id: 'mock-transcript-2',
        title: 'Product Review',
        createdAt: '2026-03-17T14:30:00Z',
        duration: 3600,
        summary: 'Reviewed roadmap priorities for Q2.',
      },
    ];
  }

  // Real implementation would call the Otter.ai API here
  // e.g. GET https://otter.ai/forward/api/v1/speeches
  throw new Error('Live Otter.ai API integration not yet implemented');
}

/**
 * Fetch a single transcript by ID from Otter.ai.
 * Returns mock data when OTTER_API_KEY is not configured.
 */
export async function getTranscript(id: string): Promise<OtterTranscriptDetail> {
  if (!OTTER_API_KEY) {
    const mockTranscripts: Record<string, OtterTranscriptDetail> = {
      'mock-transcript-1': {
        id: 'mock-transcript-1',
        title: 'Weekly Standup - Mar 18',
        createdAt: '2026-03-18T10:00:00Z',
        duration: 1800,
        summary: 'Team discussed sprint progress and blockers.',
        text: [
          'Alice  0:00',
          "Good morning everyone. Let's go around and share updates.",
          '',
          'Bob  0:15',
          "I finished the API refactor yesterday. No blockers on my end.",
          '',
          'Alice  0:30',
          'Great. Any questions before we move on?',
        ].join('\n'),
        speakers: ['Alice', 'Bob'],
      },
      'mock-transcript-2': {
        id: 'mock-transcript-2',
        title: 'Product Review',
        createdAt: '2026-03-17T14:30:00Z',
        duration: 3600,
        summary: 'Reviewed roadmap priorities for Q2.',
        text: [
          'PM  0:00',
          "Let's review the Q2 roadmap priorities.",
          '',
          'Designer  0:10',
          'I have the mockups ready for the new dashboard.',
        ].join('\n'),
        speakers: ['PM', 'Designer'],
      },
    };

    const transcript = mockTranscripts[id];
    if (!transcript) {
      throw new Error(`Transcript not found: ${id}`);
    }
    return transcript;
  }

  // Real implementation would call the Otter.ai API here
  throw new Error('Live Otter.ai API integration not yet implemented');
}

export const otterService = {
  formatTranscriptForIntake,
  importTranscript,
  listTranscripts,
  getTranscript,
};
