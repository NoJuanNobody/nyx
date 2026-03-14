import Anthropic from '@anthropic-ai/sdk';
import { config } from '../lib/config.js';

const MODEL = 'claude-sonnet-4-20250514';

const client = config.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })
  : null;

function requireClient(): Anthropic {
  if (!client) {
    throw new Error('ANTHROPIC_API_KEY is not configured. Transcription requires a valid API key.');
  }
  return client;
}

/** Supported audio MIME types */
const SUPPORTED_MIME_TYPES = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/m4a',
  'audio/mp4',
  'audio/x-m4a',
  'audio/webm',
]);

/** Supported file extensions */
const SUPPORTED_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.webm']);

/** Maximum file size: 25MB */
const MAX_FILE_SIZE = 25 * 1024 * 1024;

export interface TranscriptionResult {
  transcript: string;
}

function normalizeMediaType(
  mimeType: string,
): 'audio/mpeg' | 'audio/wav' | 'audio/mp4' | 'audio/webm' {
  const lower = mimeType.toLowerCase();
  if (lower.includes('mp3') || lower === 'audio/mpeg') return 'audio/mpeg';
  if (lower.includes('wav')) return 'audio/wav';
  if (lower.includes('m4a') || lower === 'audio/mp4' || lower === 'audio/x-m4a') return 'audio/mp4';
  if (lower.includes('webm')) return 'audio/webm';
  return 'audio/mpeg'; // fallback
}

export const transcriptionService = {
  /**
   * Validate that the provided file is an acceptable audio upload.
   */
  validateAudioFile(
    filename: string | undefined,
    mimeType: string | undefined,
    size: number,
  ): { valid: boolean; error?: string } {
    if (size > MAX_FILE_SIZE) {
      return { valid: false, error: `File too large. Maximum size is 25MB, got ${Math.round(size / 1024 / 1024)}MB.` };
    }

    if (filename) {
      const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
      if (!SUPPORTED_EXTENSIONS.has(ext)) {
        return {
          valid: false,
          error: `Unsupported file extension "${ext}". Supported: ${[...SUPPORTED_EXTENSIONS].join(', ')}`,
        };
      }
    }

    if (mimeType && !SUPPORTED_MIME_TYPES.has(mimeType.toLowerCase())) {
      return {
        valid: false,
        error: `Unsupported MIME type "${mimeType}". Supported: mp3, wav, m4a, webm`,
      };
    }

    return { valid: true };
  },

  /**
   * Transcribe an audio buffer using Claude API.
   * Falls back to requiring a manual transcript paste if the API call fails.
   */
  async transcribeAudio(
    buffer: Buffer,
    mimeType: string,
  ): Promise<TranscriptionResult> {
    const ai = requireClient();

    const mediaType = normalizeMediaType(mimeType);
    const base64Data = buffer.toString('base64');

    const response = await ai.messages.create({
      model: MODEL,
      max_tokens: 8192,
      system:
        'You are a professional transcriptionist. Transcribe the provided audio accurately and completely. Output ONLY the transcript text with no commentary, no timestamps, and no speaker labels unless they are clearly identifiable. Preserve paragraph breaks for natural pauses.',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'input_audio' as any,
              source: {
                type: 'base64',
                media_type: mediaType,
                data: base64Data,
              },
            } as any,
            {
              type: 'text' as const,
              text: 'Please transcribe this audio recording accurately.',
            },
          ],
        },
      ],
    });

    const text =
      response.content[0].type === 'text' ? response.content[0].text : '';

    if (!text.trim()) {
      throw new Error('Transcription produced empty result. The audio may be unclear or empty.');
    }

    return { transcript: text.trim() };
  },

  /**
   * Process a text transcript through the AI to produce a structured spec.
   * This converts raw transcript text into a structured document.
   */
  async structureTranscript(
    transcript: string,
  ): Promise<{ title: string; content: string }> {
    const ai = requireClient();

    const response = await ai.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system:
        'You are a technical product manager. Given a transcript from a voice memo or meeting recording, extract and structure the key information into a product specification document. Identify: goals, requirements, constraints, decisions, action items, and any technical details mentioned. Respond ONLY with valid JSON in this exact format: {"title": "<document title>", "content": "<full markdown content>"}',
      messages: [
        {
          role: 'user',
          content: `Structure this transcript into a product specification:\n\n${transcript}`,
        },
      ],
    });

    let text =
      response.content[0].type === 'text' ? response.content[0].text : '';

    // Strip code fences
    text = text
      .replace(/```(?:json)?\s*\n?/g, '')
      .replace(/\n?\s*```/g, '')
      .trim();

    // Try to extract JSON
    const jsonMatch = text.match(/\{[\s\S]*"content"\s*:\s*"[\s\S]*\}/);
    const jsonCandidate = jsonMatch ? jsonMatch[0] : text;

    try {
      const parsed = JSON.parse(jsonCandidate) as {
        title: string;
        content: string;
      };
      return {
        title: parsed.title || 'Untitled Transcript',
        content: parsed.content || text,
      };
    } catch {
      const headingMatch = text.match(/^#\s+(.+)$/m);
      return {
        title: headingMatch ? headingMatch[1].trim() : 'Untitled Transcript',
        content: text,
      };
    }
  },
};
