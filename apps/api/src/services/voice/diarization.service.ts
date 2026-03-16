import type { TranscriptSegment } from '@nyx/shared';

/**
 * MVP diarization service — splits transcript text into speaker-attributed segments
 * by matching common patterns like "Speaker 1:", "[Speaker A]", or newlines.
 *
 * Designed to be replaced with real diarization (e.g., PersonaPlex or Whisper) later.
 */

/** Pattern: "Speaker 1:" or "Speaker A:" at start of line */
const COLON_PATTERN = /^(Speaker\s*\w+)\s*:\s*/i;

/** Pattern: "[Speaker A]" or "[John]" at start of line */
const BRACKET_PATTERN = /^\[([^\]]+)\]\s*/;

type DiarizeStrategy = 'colon' | 'bracket' | 'newline';

function detectStrategy(transcript: string): DiarizeStrategy {
  const lines = transcript.split('\n').filter((l) => l.trim().length > 0);
  const colonMatches = lines.filter((l) => COLON_PATTERN.test(l.trim())).length;
  const bracketMatches = lines.filter((l) => BRACKET_PATTERN.test(l.trim())).length;

  if (colonMatches >= 2) return 'colon';
  if (bracketMatches >= 2) return 'bracket';
  return 'newline';
}

function diarizeByPattern(
  transcript: string,
  pattern: RegExp,
): TranscriptSegment[] {
  const lines = transcript.split('\n').filter((l) => l.trim().length > 0);
  const segments: TranscriptSegment[] = [];
  let currentMs = 0;
  const avgSegmentMs = 5000; // 5s per segment estimate

  for (const line of lines) {
    const trimmed = line.trim();
    const match = trimmed.match(pattern);

    if (match) {
      const speaker = match[1].trim();
      const text = trimmed.slice(match[0].length).trim();
      if (text) {
        const startMs = currentMs;
        const endMs = currentMs + avgSegmentMs;
        segments.push({ speaker, text, startMs, endMs });
        currentMs = endMs;
      }
    } else if (trimmed && segments.length > 0) {
      // Continuation of previous speaker
      const last = segments[segments.length - 1];
      last.text += ' ' + trimmed;
      last.endMs += avgSegmentMs;
      currentMs = last.endMs;
    } else if (trimmed) {
      // No pattern matched and no prior segment — assign to Unknown
      const startMs = currentMs;
      const endMs = currentMs + avgSegmentMs;
      segments.push({ speaker: 'Unknown', text: trimmed, startMs, endMs });
      currentMs = endMs;
    }
  }

  return segments;
}

function diarizeByNewline(transcript: string): TranscriptSegment[] {
  const lines = transcript.split('\n').filter((l) => l.trim().length > 0);
  const segments: TranscriptSegment[] = [];
  let currentMs = 0;
  const avgSegmentMs = 5000;

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].trim();
    const speaker = `Speaker ${(i % 2) + 1}`;
    const startMs = currentMs;
    const endMs = currentMs + avgSegmentMs;
    segments.push({ speaker, text, startMs, endMs });
    currentMs = endMs;
  }

  return segments;
}

export const diarizationService = {
  /**
   * Split transcript text into speaker-attributed segments.
   * For MVP, detects common speaker label patterns and falls back to
   * alternating speakers on newlines.
   */
  diarize(transcript: string): TranscriptSegment[] {
    if (!transcript.trim()) return [];

    const strategy = detectStrategy(transcript);

    switch (strategy) {
      case 'colon':
        return diarizeByPattern(transcript, COLON_PATTERN);
      case 'bracket':
        return diarizeByPattern(transcript, BRACKET_PATTERN);
      case 'newline':
        return diarizeByNewline(transcript);
    }
  },
};
