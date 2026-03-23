import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDb, mockFetch } from '../../__tests__/helpers/setup.js';

// Import after mocks are set up
const { claudeInsightsService, parseClaudeComment } = await import(
  '../claude-insights.service.js'
);

describe('parseClaudeComment', () => {
  it('parses a standard Claude comment with title, summary, and files', () => {
    const markdown = [
      '## Implement auth endpoints',
      '',
      'Added JWT middleware to all protected routes.',
      '',
      '- Created /api/auth/login endpoint',
      '- Created /api/auth/logout endpoint',
      '',
      '### Files changed',
      '',
      '- apps/api/src/middleware/auth.ts',
      '- apps/api/src/routes/auth.ts',
    ].join('\n');

    const result = parseClaudeComment(markdown);

    expect(result.title).toBe('Implement auth endpoints');
    expect(result.summary).toEqual([
      'Added JWT middleware to all protected routes.',
      'Created /api/auth/login endpoint',
      'Created /api/auth/logout endpoint',
    ]);
    expect(result.filesChanged).toEqual([
      'apps/api/src/middleware/auth.ts',
      'apps/api/src/routes/auth.ts',
    ]);
  });

  it('extracts title from first heading', () => {
    const markdown = '# My Task Title\n\nSome summary text.';
    const result = parseClaudeComment(markdown);
    expect(result.title).toBe('My Task Title');
    expect(result.summary).toContain('Some summary text.');
  });

  it('falls back to first non-empty line if no heading', () => {
    const markdown = 'Plain text without headings\nSecond line';
    const result = parseClaudeComment(markdown);
    expect(result.title).toBe('Plain text without headings');
  });

  it('returns default title for empty input', () => {
    const result = parseClaudeComment('');
    expect(result.title).toBe('Claude Action');
    expect(result.summary).toEqual([]);
    expect(result.filesChanged).toEqual([]);
  });

  it('limits summary to 10 items', () => {
    const bullets = Array.from({ length: 15 }, (_, i) => `- Bullet ${i + 1}`).join('\n');
    const markdown = `## Title\n\n${bullets}`;
    const result = parseClaudeComment(markdown);
    expect(result.summary.length).toBe(10);
  });

  it('limits filesChanged to 20 items', () => {
    const files = Array.from({ length: 25 }, (_, i) => `- file${i + 1}.ts`).join('\n');
    const markdown = `## Title\n\n### Files changed\n\n${files}`;
    const result = parseClaudeComment(markdown);
    expect(result.filesChanged.length).toBe(20);
  });

  it('recognises heading keywords for files section', () => {
    const markdown = [
      '## Fix bug',
      '',
      '- Fixed the issue',
      '',
      '### Modified files',
      '',
      '- src/index.ts',
    ].join('\n');
    const result = parseClaudeComment(markdown);
    expect(result.filesChanged).toEqual(['src/index.ts']);
    expect(result.summary).toEqual(['Fixed the issue']);
  });

  it('switches to summary mode on "overview" heading', () => {
    const markdown = [
      '## Task',
      '',
      '### Overview',
      '',
      '- Point A',
      '- Point B',
    ].join('\n');
    const result = parseClaudeComment(markdown);
    expect(result.summary).toContain('Point A');
    expect(result.summary).toContain('Point B');
  });

  it('strips backticks from file paths', () => {
    const markdown = [
      '## Task',
      '',
      '### Files changed',
      '',
      '- `src/utils.ts`',
      '- `apps/web/src/App.tsx`',
    ].join('\n');
    const result = parseClaudeComment(markdown);
    expect(result.filesChanged).toEqual(['src/utils.ts', 'apps/web/src/App.tsx']);
  });

  it('ignores code fence markers and table rows in summary', () => {
    const markdown = [
      '## Task',
      '',
      'Summary line.',
      '```',
      '| col1 | col2 |',
    ].join('\n');
    const result = parseClaudeComment(markdown);
    expect(result.summary).toEqual(['Summary line.']);
  });
});

describe('isClaudeComment', () => {
  const { isClaudeComment } = claudeInsightsService;

  function comment(login: string, type: string) {
    return { id: 1, html_url: '', body: '', created_at: '', user: { login, type } };
  }

  it('recognises github-actions[bot]', () => {
    expect(isClaudeComment(comment('github-actions[bot]', 'Bot'))).toBe(true);
  });

  it('recognises claude[bot]', () => {
    expect(isClaudeComment(comment('claude[bot]', 'Bot'))).toBe(true);
  });

  it('recognises claude-code[bot]', () => {
    expect(isClaudeComment(comment('claude-code[bot]', 'Bot'))).toBe(true);
  });

  it('recognises anthropic-claude[bot]', () => {
    expect(isClaudeComment(comment('anthropic-claude[bot]', 'Bot'))).toBe(true);
  });

  it('recognises any bot with "claude" in login', () => {
    expect(isClaudeComment(comment('my-claude-helper', 'Bot'))).toBe(true);
  });

  it('rejects non-claude bot user', () => {
    expect(isClaudeComment(comment('dependabot[bot]', 'Bot'))).toBe(false);
  });

  it('rejects non-bot user even with claude in name', () => {
    expect(isClaudeComment(comment('claude-fan', 'User'))).toBe(false);
  });

  it('handles missing user gracefully', () => {
    expect(isClaudeComment(comment('', ''))).toBe(false);
  });
});

describe('claudeInsightsService.getForTicket', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns stored insight from ticket', async () => {
    const insight = {
      title: 'Test',
      summary: ['Did stuff'],
      filesChanged: ['a.ts'],
      commentId: 123,
      commentUrl: 'https://github.com/test',
      commentedAt: '2026-03-14T12:00:00Z',
      fetchedAt: '2026-03-14T12:05:00Z',
    };

    // Make the chain resolve to a ticket with insight
    const chain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([{ claudeInsights: insight }]),
    };
    mockDb.select.mockReturnValueOnce(chain as unknown as ReturnType<typeof mockDb.select>);

    const result = await claudeInsightsService.getForTicket('ticket-id');
    expect(result).toEqual(insight);
  });

  it('returns null when no insight stored', async () => {
    const chain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([{ claudeInsights: null }]),
    };
    mockDb.select.mockReturnValueOnce(chain as unknown as ReturnType<typeof mockDb.select>);

    const result = await claudeInsightsService.getForTicket('ticket-id');
    expect(result).toBeNull();
  });

  it('throws when ticket not found', async () => {
    const chain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    };
    mockDb.select.mockReturnValueOnce(chain as unknown as ReturnType<typeof mockDb.select>);

    await expect(claudeInsightsService.getForTicket('missing-id')).rejects.toThrow(
      'Ticket not found',
    );
  });
});

describe('claudeInsightsService.handleIssueCommentWebhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ignores non-claude comments', async () => {
    await claudeInsightsService.handleIssueCommentWebhook(
      'org',
      'repo',
      42,
      {
        id: 1,
        html_url: 'https://github.com/org/repo/issues/42#issuecomment-1',
        body: 'Regular comment',
        created_at: '2026-03-14T12:00:00Z',
        user: { login: 'regular-user', type: 'User' },
      },
    );

    // Should not query DB at all for non-claude comments
    expect(mockDb.select).not.toHaveBeenCalled();
  });
});
