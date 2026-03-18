import { describe, it, expect } from 'vitest';
import {
  formatTranscriptForIntake,
  importTranscript,
  listTranscripts,
  getTranscript,
} from '../integrations/otter.service.js';

describe('otterService', () => {
  describe('formatTranscriptForIntake', () => {
    it('should wrap transcript in markdown heading with timestamp', () => {
      const result = formatTranscriptForIntake('Hello world');
      expect(result).toContain('## Otter.ai Transcript');
      expect(result).toContain('_Imported on');
      expect(result).toContain('Hello world');
    });

    it('should detect and format speaker labels with timestamps', () => {
      const input = [
        'Alice  0:00',
        'Welcome everyone.',
        '',
        'Bob  1:23',
        'Thanks for having me.',
      ].join('\n');

      const result = formatTranscriptForIntake(input);
      expect(result).toContain('**Alice** _(0:00)_');
      expect(result).toContain('**Bob** _(1:23)_');
      expect(result).toContain('Welcome everyone.');
      expect(result).toContain('Thanks for having me.');
    });

    it('should handle speaker labels with HH:MM:SS timestamps', () => {
      const input = 'Speaker 1  1:02:30\nLong meeting comment.';
      const result = formatTranscriptForIntake(input);
      expect(result).toContain('**Speaker 1** _(1:02:30)_');
    });

    it('should handle empty lines gracefully', () => {
      const input = 'Line one\n\nLine two';
      const result = formatTranscriptForIntake(input);
      expect(result).toContain('Line one');
      expect(result).toContain('Line two');
    });

    it('should trim leading and trailing whitespace from the transcript', () => {
      const result = formatTranscriptForIntake('   Hello   \n   World   ');
      expect(result).toContain('Hello');
      expect(result).toContain('World');
    });
  });

  describe('importTranscript', () => {
    it('should append transcript to empty existing content', () => {
      const { content, formattedText } = importTranscript('Hello', '');
      expect(content).toContain('## Otter.ai Transcript');
      expect(content).toContain('Hello');
      // No separator for empty content
      expect(content).not.toContain('---');
      expect(formattedText.length).toBeGreaterThan(0);
    });

    it('should append transcript to existing content with separator', () => {
      const { content } = importTranscript('New transcript', 'Existing document content');
      expect(content).toMatch(/^Existing document content\n\n---\n\n## Otter\.ai Transcript/);
      expect(content).toContain('New transcript');
    });

    it('should throw on empty transcript text', () => {
      expect(() => importTranscript('', 'existing')).toThrow('Transcript text cannot be empty');
      expect(() => importTranscript('   ', 'existing')).toThrow(
        'Transcript text cannot be empty',
      );
    });

    it('should preserve speaker labels and timestamps in appended content', () => {
      const transcript = 'Alice  0:00\nHello.\n\nBob  0:05\nHi there.';
      const { content } = importTranscript(transcript, 'Existing');
      expect(content).toContain('**Alice** _(0:00)_');
      expect(content).toContain('**Bob** _(0:05)_');
    });
  });

  describe('listTranscripts', () => {
    it('should return mock transcripts when OTTER_API_KEY is not set', async () => {
      const transcripts = await listTranscripts();
      expect(transcripts).toHaveLength(2);
      expect(transcripts[0]).toHaveProperty('id');
      expect(transcripts[0]).toHaveProperty('title');
      expect(transcripts[0]).toHaveProperty('createdAt');
      expect(transcripts[0]).toHaveProperty('duration');
      expect(transcripts[0]).toHaveProperty('summary');
    });

    it('should return transcripts with expected mock IDs', async () => {
      const transcripts = await listTranscripts();
      const ids = transcripts.map((t) => t.id);
      expect(ids).toContain('mock-transcript-1');
      expect(ids).toContain('mock-transcript-2');
    });
  });

  describe('getTranscript', () => {
    it('should return mock transcript detail by ID', async () => {
      const transcript = await getTranscript('mock-transcript-1');
      expect(transcript.id).toBe('mock-transcript-1');
      expect(transcript.title).toBe('Weekly Standup - Mar 18');
      expect(transcript.text).toBeTruthy();
      expect(transcript.speakers).toContain('Alice');
      expect(transcript.speakers).toContain('Bob');
    });

    it('should throw for non-existent transcript ID', async () => {
      await expect(getTranscript('nonexistent')).rejects.toThrow('Transcript not found');
    });

    it('should return full transcript text with speaker turns', async () => {
      const transcript = await getTranscript('mock-transcript-2');
      expect(transcript.text).toContain('PM');
      expect(transcript.text).toContain('Designer');
      expect(transcript.speakers).toEqual(['PM', 'Designer']);
    });
  });
});
