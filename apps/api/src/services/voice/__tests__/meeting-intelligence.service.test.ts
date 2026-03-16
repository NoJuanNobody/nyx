import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreate = vi.hoisted(() => vi.fn());

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = { create: mockCreate };
    },
  };
});

vi.mock('../../transcription.service.js', () => ({
  transcriptionService: {
    transcribeAudio: vi.fn(),
  },
}));

import { meetingIntelligenceService } from '../meeting-intelligence.service.js';
import { transcriptionService } from '../../transcription.service.js';

function makeResponse(text: string) {
  return { content: [{ type: 'text', text }] };
}

const MOCK_PARSED = {
  decisions: [{ id: 'd-1', text: 'Use Fastify', madeBy: 'Alice' }],
  actionItems: [
    { id: 'a-1', text: 'Set up routes', assignee: 'Bob', status: 'pending', priority: 'medium' },
  ],
  codeReferences: [],
  openQuestions: [
    { id: 'q-1', text: 'Which ORM?', raisedBy: 'Alice', resolved: false },
  ],
  summary: 'Team chose Fastify for the API layer.',
  participants: ['Alice', 'Bob'],
};

describe('meetingIntelligenceService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    meetingIntelligenceService.clearStore();
  });

  it('processTranscript: diarizes, parses, and returns full intelligence', async () => {
    mockCreate.mockResolvedValueOnce(makeResponse(JSON.stringify(MOCK_PARSED)));

    const result = await meetingIntelligenceService.processTranscript(
      'session-1',
      'Speaker 1: Let us use Fastify\nSpeaker 2: Sounds good',
    );

    expect(result.sessionId).toBe('session-1');
    expect(result.transcript).toHaveLength(2);
    expect(result.transcript[0].speaker).toBe('Speaker 1');
    expect(result.transcript[1].speaker).toBe('Speaker 2');
    expect(result.decisions).toHaveLength(1);
    expect(result.actionItems).toHaveLength(1);
    expect(result.summary).toContain('Fastify');
    expect(result.createdAt).toBeTruthy();
    expect(result.duration).toBeGreaterThan(0);
  });

  it('processTranscript: stores intelligence by sessionId', async () => {
    mockCreate.mockResolvedValueOnce(makeResponse(JSON.stringify(MOCK_PARSED)));

    await meetingIntelligenceService.processTranscript('session-2', 'Hello world');

    const stored = meetingIntelligenceService.getIntelligence('session-2');
    expect(stored).toBeDefined();
    expect(stored!.sessionId).toBe('session-2');
    expect(stored!.summary).toContain('Fastify');
  });

  it('getIntelligence: returns undefined for unknown session', () => {
    const result = meetingIntelligenceService.getIntelligence('nonexistent');
    expect(result).toBeUndefined();
  });

  it('processTranscript: handles AI parse failure gracefully', async () => {
    mockCreate.mockResolvedValueOnce(makeResponse('not json'));

    const result = await meetingIntelligenceService.processTranscript(
      'session-3',
      'Speaker 1: some text',
    );

    expect(result.sessionId).toBe('session-3');
    expect(result.decisions).toEqual([]);
    expect(result.summary).toContain('Failed to parse');
  });

  it('processAudioBuffer: transcribes then processes transcript', async () => {
    vi.mocked(transcriptionService.transcribeAudio).mockResolvedValueOnce({
      transcript: 'Speaker 1: Audio content here',
    });
    mockCreate.mockResolvedValueOnce(makeResponse(JSON.stringify(MOCK_PARSED)));

    const buffer = Buffer.from('fake-audio');
    const result = await meetingIntelligenceService.processAudioBuffer(
      'session-4',
      buffer,
      'audio/mpeg',
    );

    expect(transcriptionService.transcribeAudio).toHaveBeenCalledWith(buffer, 'audio/mpeg');
    expect(result.sessionId).toBe('session-4');
    expect(result.decisions).toHaveLength(1);
  });

  it('processTranscript: overwrites previous session data', async () => {
    const parsed1 = { ...MOCK_PARSED, summary: 'First session' };
    const parsed2 = { ...MOCK_PARSED, summary: 'Updated session' };

    mockCreate.mockResolvedValueOnce(makeResponse(JSON.stringify(parsed1)));
    await meetingIntelligenceService.processTranscript('session-5', 'first');

    mockCreate.mockResolvedValueOnce(makeResponse(JSON.stringify(parsed2)));
    await meetingIntelligenceService.processTranscript('session-5', 'second');

    const stored = meetingIntelligenceService.getIntelligence('session-5');
    expect(stored!.summary).toBe('Updated session');
  });

  it('generateSessionId: returns a valid UUID string', () => {
    const id = meetingIntelligenceService.generateSessionId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
