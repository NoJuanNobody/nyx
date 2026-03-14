import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDb } from '../helpers/setup.js';

// Mock Anthropic SDK
const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

// Import after mocks
const { transcriptionService } = await import('../../services/transcription.service.js');

describe('transcriptionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('validateAudioFile', () => {
    it('accepts valid mp3 file', () => {
      const result = transcriptionService.validateAudioFile('voice.mp3', 'audio/mpeg', 1024);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('accepts valid wav file', () => {
      const result = transcriptionService.validateAudioFile('recording.wav', 'audio/wav', 1024);
      expect(result.valid).toBe(true);
    });

    it('accepts valid m4a file', () => {
      const result = transcriptionService.validateAudioFile('memo.m4a', 'audio/mp4', 1024);
      expect(result.valid).toBe(true);
    });

    it('accepts valid webm file', () => {
      const result = transcriptionService.validateAudioFile('clip.webm', 'audio/webm', 1024);
      expect(result.valid).toBe(true);
    });

    it('rejects file over 25MB', () => {
      const result = transcriptionService.validateAudioFile(
        'large.mp3',
        'audio/mpeg',
        26 * 1024 * 1024,
      );
      expect(result.valid).toBe(false);
      expect(result.error).toContain('too large');
    });

    it('rejects unsupported extension', () => {
      const result = transcriptionService.validateAudioFile('file.ogg', 'audio/ogg', 1024);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Unsupported file extension');
    });

    it('rejects unsupported MIME type', () => {
      const result = transcriptionService.validateAudioFile(
        'file.mp3',
        'application/octet-stream',
        1024,
      );
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Unsupported MIME type');
    });

    it('accepts file with no filename (undefined)', () => {
      const result = transcriptionService.validateAudioFile(undefined, 'audio/mpeg', 1024);
      expect(result.valid).toBe(true);
    });

    it('accepts file with no MIME type', () => {
      const result = transcriptionService.validateAudioFile('voice.mp3', undefined, 1024);
      expect(result.valid).toBe(true);
    });
  });

  describe('transcribeAudio', () => {
    it('returns transcript from Claude API', async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'This is the transcribed audio content.' }],
      });

      const buffer = Buffer.from('fake-audio-data');
      const result = await transcriptionService.transcribeAudio(buffer, 'audio/mpeg');

      expect(result.transcript).toBe('This is the transcribed audio content.');
      expect(mockCreate).toHaveBeenCalledOnce();
      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.messages[0].content[0].type).toBe('input_audio');
      expect(callArgs.messages[0].content[0].source.media_type).toBe('audio/mpeg');
    });

    it('throws on empty transcription result', async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: '   ' }],
      });

      const buffer = Buffer.from('fake-audio-data');
      await expect(transcriptionService.transcribeAudio(buffer, 'audio/mpeg')).rejects.toThrow(
        'empty result',
      );
    });

    it('normalizes m4a MIME type to audio/mp4', async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Transcript here' }],
      });

      const buffer = Buffer.from('fake-audio-data');
      await transcriptionService.transcribeAudio(buffer, 'audio/x-m4a');

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.messages[0].content[0].source.media_type).toBe('audio/mp4');
    });
  });

  describe('structureTranscript', () => {
    it('parses valid JSON response', async () => {
      mockCreate.mockResolvedValueOnce({
        content: [
          {
            type: 'text',
            text: '{"title": "Meeting Notes", "content": "# Meeting Notes\\n\\n- Item 1"}',
          },
        ],
      });

      const result = await transcriptionService.structureTranscript('raw transcript text');
      expect(result.title).toBe('Meeting Notes');
      expect(result.content).toContain('Meeting Notes');
    });

    it('handles code-fenced JSON response', async () => {
      mockCreate.mockResolvedValueOnce({
        content: [
          {
            type: 'text',
            text: '```json\n{"title": "Spec", "content": "# Spec\\nDetails"}\n```',
          },
        ],
      });

      const result = await transcriptionService.structureTranscript('raw transcript');
      expect(result.title).toBe('Spec');
    });

    it('falls back to heading extraction on invalid JSON', async () => {
      mockCreate.mockResolvedValueOnce({
        content: [
          {
            type: 'text',
            text: '# Product Requirements\n\nSome content here.',
          },
        ],
      });

      const result = await transcriptionService.structureTranscript('raw transcript');
      expect(result.title).toBe('Product Requirements');
      expect(result.content).toContain('Some content');
    });

    it('uses default title when no heading found', async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Just plain text without a heading.' }],
      });

      const result = await transcriptionService.structureTranscript('raw transcript');
      expect(result.title).toBe('Untitled Transcript');
      expect(result.content).toBe('Just plain text without a heading.');
    });
  });
});
