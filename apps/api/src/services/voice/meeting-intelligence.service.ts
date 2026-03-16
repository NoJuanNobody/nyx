import { randomUUID } from 'node:crypto';
import type { MeetingIntelligence } from '@nyx/shared';
import { transcriptionService } from '../transcription.service.js';
import { semanticParserService } from './semantic-parser.service.js';
import { diarizationService } from './diarization.service.js';

/** In-memory store for session intelligence results */
const intelligenceStore = new Map<string, MeetingIntelligence>();

export const meetingIntelligenceService = {
  /**
   * Process a raw transcript string: diarize, parse semantically, and store results.
   */
  async processTranscript(
    sessionId: string,
    transcript: string,
  ): Promise<MeetingIntelligence> {
    const segments = diarizationService.diarize(transcript);
    const parsed = await semanticParserService.parseTranscript(transcript);

    const duration =
      segments.length > 0 ? segments[segments.length - 1].endMs : 0;

    const intelligence: MeetingIntelligence = {
      sessionId,
      transcript: segments,
      decisions: parsed.decisions,
      actionItems: parsed.actionItems,
      codeReferences: parsed.codeReferences,
      openQuestions: parsed.openQuestions,
      summary: parsed.summary,
      duration,
      participants: parsed.participants,
      createdAt: new Date().toISOString(),
    };

    intelligenceStore.set(sessionId, intelligence);
    return intelligence;
  },

  /**
   * Process an audio buffer: transcribe first, then parse.
   */
  async processAudioBuffer(
    sessionId: string,
    buffer: Buffer,
    mimeType: string,
  ): Promise<MeetingIntelligence> {
    const { transcript } = await transcriptionService.transcribeAudio(buffer, mimeType);
    return this.processTranscript(sessionId, transcript);
  },

  /**
   * Retrieve stored intelligence for a session.
   */
  getIntelligence(sessionId: string): MeetingIntelligence | undefined {
    return intelligenceStore.get(sessionId);
  },

  /**
   * Generate a new session ID.
   */
  generateSessionId(): string {
    return randomUUID();
  },

  /**
   * Clear stored intelligence (useful for testing).
   */
  clearStore(): void {
    intelligenceStore.clear();
  },
};
