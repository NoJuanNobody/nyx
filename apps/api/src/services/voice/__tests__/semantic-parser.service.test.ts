import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreate = vi.hoisted(() => vi.fn());

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = { create: mockCreate };
    },
  };
});

import { semanticParserService } from '../semantic-parser.service.js';

function makeResponse(text: string) {
  return { content: [{ type: 'text', text }] };
}

const VALID_PARSED = {
  decisions: [{ id: 'd-1', text: 'Use PostgreSQL', madeBy: 'Alice' }],
  actionItems: [
    { id: 'a-1', text: 'Set up DB', assignee: 'Bob', status: 'pending', priority: 'high' },
  ],
  codeReferences: [
    { id: 'c-1', filePath: 'src/db.ts', symbol: 'initDb', repository: 'nyx' },
  ],
  openQuestions: [
    { id: 'q-1', text: 'Which region?', raisedBy: 'Alice', resolved: false },
  ],
  summary: 'Team decided on PostgreSQL. Bob to set up DB.',
  participants: ['Alice', 'Bob'],
};

describe('semanticParserService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parseTranscript: returns parsed intelligence from valid AI response', async () => {
    mockCreate.mockResolvedValueOnce(makeResponse(JSON.stringify(VALID_PARSED)));

    const result = await semanticParserService.parseTranscript('Alice: Let us use PostgreSQL');

    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].text).toBe('Use PostgreSQL');
    expect(result.actionItems).toHaveLength(1);
    expect(result.actionItems[0].assignee).toBe('Bob');
    expect(result.codeReferences).toHaveLength(1);
    expect(result.openQuestions).toHaveLength(1);
    expect(result.summary).toContain('PostgreSQL');
    expect(result.participants).toEqual(['Alice', 'Bob']);
  });

  it('parseTranscript: strips code fences from AI response', async () => {
    const wrapped = '```json\n' + JSON.stringify(VALID_PARSED) + '\n```';
    mockCreate.mockResolvedValueOnce(makeResponse(wrapped));

    const result = await semanticParserService.parseTranscript('some transcript');

    expect(result.decisions).toHaveLength(1);
    expect(result.summary).toContain('PostgreSQL');
  });

  it('parseTranscript: returns empty result for empty transcript', async () => {
    const result = await semanticParserService.parseTranscript('');

    expect(mockCreate).not.toHaveBeenCalled();
    expect(result.decisions).toEqual([]);
    expect(result.actionItems).toEqual([]);
    expect(result.summary).toBe('');
  });

  it('parseTranscript: returns graceful fallback on malformed JSON response', async () => {
    mockCreate.mockResolvedValueOnce(makeResponse('This is not valid JSON at all'));

    const result = await semanticParserService.parseTranscript('some transcript');

    expect(result.decisions).toEqual([]);
    expect(result.actionItems).toEqual([]);
    expect(result.summary).toContain('Failed to parse');
  });

  it('parseTranscript: returns graceful fallback on API error', async () => {
    mockCreate.mockRejectedValueOnce(new Error('API rate limit exceeded'));

    await expect(
      semanticParserService.parseTranscript('some transcript'),
    ).rejects.toThrow('API rate limit exceeded');
  });

  it('parseTranscript: handles partial response with missing fields', async () => {
    const partial = { decisions: [{ id: 'd-1', text: 'Go with React' }], summary: 'Use React' };
    mockCreate.mockResolvedValueOnce(makeResponse(JSON.stringify(partial)));

    const result = await semanticParserService.parseTranscript('some transcript');

    expect(result.decisions).toHaveLength(1);
    expect(result.actionItems).toEqual([]);
    expect(result.codeReferences).toEqual([]);
    expect(result.openQuestions).toEqual([]);
    expect(result.participants).toEqual([]);
    expect(result.summary).toBe('Use React');
  });

  it('parseTranscript: extracts JSON embedded in prose', async () => {
    const prose =
      'Here is the analysis:\n' + JSON.stringify(VALID_PARSED) + '\n\nHope that helps!';
    mockCreate.mockResolvedValueOnce(makeResponse(prose));

    const result = await semanticParserService.parseTranscript('some transcript');

    expect(result.decisions).toHaveLength(1);
    expect(result.summary).toContain('PostgreSQL');
  });
});
