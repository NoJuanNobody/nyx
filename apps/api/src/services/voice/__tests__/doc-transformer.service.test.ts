import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MeetingIntelligence } from '@nyx/shared';
import { transformToDocument, createMeetingDocument } from '../doc-transformer.service.js';

// ── Mock drizzle db ─────────────────────────────────────────────

let insertResults: unknown[][] = [];
let insertCallIndex = 0;

function resetDbMock(results: unknown[][] = []) {
  insertResults = results;
  insertCallIndex = 0;
}

vi.mock('../../../db/index.js', () => ({
  db: {
    insert: () => ({
      values: () => {
        const idx = insertCallIndex++;
        const result = insertResults[idx] ?? [];
        // Return a thenable that also exposes .returning()
        const obj = {
          returning: async () => result,
          then: (resolve: (v: unknown) => void) => resolve(result),
        };
        return obj;
      },
    }),
  },
}));

vi.mock('../../../db/schema.js', () => ({
  documents: Symbol('documents'),
  meetingDocuments: Symbol('meetingDocuments'),
}));

// ── Fixtures ────────────────────────────────────────────────────

function makeIntelligence(overrides: Partial<MeetingIntelligence> = {}): MeetingIntelligence {
  return {
    sessionId: 'sess-001',
    transcript: [
      { speaker: 'Alice', text: 'Hello everyone', startMs: 0, endMs: 2000 },
    ],
    decisions: [
      { id: 'd1', text: 'Use Fastify for the API', madeBy: 'Alice' },
    ],
    actionItems: [
      {
        id: 'a1',
        text: 'Set up CI pipeline',
        assignee: 'Bob',
        deadline: '2026-04-01',
        priority: 'high',
        status: 'pending',
      },
    ],
    codeReferences: [
      { id: 'c1', filePath: 'src/app.ts', symbol: 'buildApp', repository: 'nyx' },
    ],
    openQuestions: [
      { id: 'q1', text: 'Which auth provider?', raisedBy: 'Charlie', resolved: false },
    ],
    summary: 'Discussed API architecture and CI setup.',
    duration: 3600000,
    participants: ['Alice', 'Bob', 'Charlie'],
    createdAt: '2026-03-16T10:00:00.000Z',
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────

describe('transformToDocument', () => {
  it('generates a markdown document with all sections', () => {
    const intelligence = makeIntelligence();
    const result = transformToDocument(intelligence);

    expect(result.title).toContain('Meeting Notes:');
    expect(result.content).toContain('# Meeting Notes:');
    expect(result.content).toContain('## Summary');
    expect(result.content).toContain('Discussed API architecture and CI setup.');
    expect(result.content).toContain('## Decisions');
    expect(result.content).toContain('Use Fastify for the API');
    expect(result.content).toContain('_(by Alice)_');
    expect(result.content).toContain('## Action Items');
    expect(result.content).toContain('- [ ] Set up CI pipeline');
    expect(result.content).toContain('assignee: Bob');
    expect(result.content).toContain('deadline: 2026-04-01');
    expect(result.content).toContain('priority: high');
    expect(result.content).toContain('## Code References');
    expect(result.content).toContain('`src/app.ts`');
    expect(result.content).toContain('`buildApp`');
    expect(result.content).toContain('repo: nyx');
    expect(result.content).toContain('## Open Questions');
    expect(result.content).toContain('Which auth provider?');
    expect(result.content).toContain('_(raised by Charlie)_');
    expect(result.content).toContain('## Participants');
    expect(result.content).toContain('- Alice');
    expect(result.content).toContain('- Bob');
    expect(result.content).toContain('- Charlie');
  });

  it('renders done action items as checked', () => {
    const intelligence = makeIntelligence({
      actionItems: [
        { id: 'a1', text: 'Done task', status: 'done' },
      ],
    });
    const result = transformToDocument(intelligence);
    expect(result.content).toContain('- [x] Done task');
  });

  it('handles empty decisions gracefully', () => {
    const intelligence = makeIntelligence({ decisions: [] });
    const result = transformToDocument(intelligence);
    expect(result.content).toContain('_No decisions recorded._');
  });

  it('handles empty action items gracefully', () => {
    const intelligence = makeIntelligence({ actionItems: [] });
    const result = transformToDocument(intelligence);
    expect(result.content).toContain('_No action items recorded._');
  });

  it('handles empty code references gracefully', () => {
    const intelligence = makeIntelligence({ codeReferences: [] });
    const result = transformToDocument(intelligence);
    expect(result.content).toContain('_No code references recorded._');
  });

  it('handles empty open questions gracefully', () => {
    const intelligence = makeIntelligence({ openQuestions: [] });
    const result = transformToDocument(intelligence);
    expect(result.content).toContain('_No open questions recorded._');
  });

  it('handles empty participants gracefully', () => {
    const intelligence = makeIntelligence({ participants: [] });
    const result = transformToDocument(intelligence);
    expect(result.content).toContain('_No participants recorded._');
  });

  it('handles empty summary', () => {
    const intelligence = makeIntelligence({ summary: '' });
    const result = transformToDocument(intelligence);
    expect(result.content).toContain('_No summary available._');
  });

  it('marks resolved open questions', () => {
    const intelligence = makeIntelligence({
      openQuestions: [
        { id: 'q1', text: 'Resolved question', resolved: true },
      ],
    });
    const result = transformToDocument(intelligence);
    expect(result.content).toContain('**[RESOLVED]**');
  });

  it('handles code references with only context', () => {
    const intelligence = makeIntelligence({
      codeReferences: [
        { id: 'c1', context: 'mentioned auth module' },
      ],
    });
    const result = transformToDocument(intelligence);
    expect(result.content).toContain('mentioned auth module');
  });

  it('handles fully empty intelligence', () => {
    const intelligence = makeIntelligence({
      decisions: [],
      actionItems: [],
      codeReferences: [],
      openQuestions: [],
      participants: [],
      summary: '',
    });
    const result = transformToDocument(intelligence);
    expect(result.title).toContain('Meeting Notes:');
    expect(result.content).toContain('_No summary available._');
    expect(result.content).toContain('_No decisions recorded._');
    expect(result.content).toContain('_No action items recorded._');
    expect(result.content).toContain('_No code references recorded._');
    expect(result.content).toContain('_No open questions recorded._');
    expect(result.content).toContain('_No participants recorded._');
  });
});

describe('createMeetingDocument', () => {
  beforeEach(() => {
    resetDbMock();
  });

  it('inserts a document and a meetingDocuments join record', async () => {
    const fakeDoc = { id: 'doc-uuid-123' };
    resetDbMock([[fakeDoc], []]);

    const intelligence = makeIntelligence();
    const result = await createMeetingDocument(intelligence, 'team-1', 'user-1', 'zoom');

    expect(result).toBe('doc-uuid-123');
    expect(insertCallIndex).toBe(2);
  });

  it('defaults platform to unknown', async () => {
    const fakeDoc = { id: 'doc-uuid-456' };
    resetDbMock([[fakeDoc], []]);

    const intelligence = makeIntelligence();
    const result = await createMeetingDocument(intelligence, 'team-1', 'user-1');

    expect(result).toBe('doc-uuid-456');
    expect(insertCallIndex).toBe(2);
  });
});
