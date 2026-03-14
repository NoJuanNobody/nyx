import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('contextMatchingService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('should return empty results when team has no documents', async () => {
    const mockSelect = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    vi.doMock('../../db/index.js', () => ({
      db: { select: mockSelect },
    }));
    vi.doMock('../../lib/config.js', () => ({
      config: { ANTHROPIC_API_KEY: 'test-key' },
    }));
    vi.doMock('@anthropic-ai/sdk', () => ({
      default: vi.fn().mockImplementation(() => ({
        messages: { create: vi.fn() },
      })),
    }));

    const { contextMatchingService } = await import('../context-matching.service.js');
    const result = await contextMatchingService.findRelatedSpecs('some input', 'team-1');

    expect(result).toEqual({ matches: [], signals: [] });
  });

  it('should return matches and signals from AI analysis', async () => {
    const mockDocs = [
      { id: 'doc-1', title: 'Auth Spec', content: 'Authentication requirements...' },
      { id: 'doc-2', title: 'API Design', content: 'REST API patterns...' },
    ];

    const aiResponse = JSON.stringify({
      matches: [
        {
          documentId: 'doc-1',
          title: 'Auth Spec',
          relevance: 'high',
          relationship: 'confirms',
          summary: 'New input aligns with existing auth requirements',
        },
      ],
      signals: [
        {
          type: 'recurring_pattern',
          description: 'Authentication has been mentioned in multiple inputs',
          relatedDocIds: ['doc-1'],
        },
      ],
    });

    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: aiResponse }],
    });

    const mockSelect = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(mockDocs),
      }),
    });

    vi.doMock('../../db/index.js', () => ({
      db: { select: mockSelect },
    }));
    vi.doMock('../../lib/config.js', () => ({
      config: { ANTHROPIC_API_KEY: 'test-key' },
    }));
    vi.doMock('@anthropic-ai/sdk', () => ({
      default: vi.fn().mockImplementation(() => ({
        messages: { create: mockCreate },
      })),
    }));

    const { contextMatchingService } = await import('../context-matching.service.js');
    const result = await contextMatchingService.findRelatedSpecs(
      'We need to add OAuth support',
      'team-1',
    );

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toEqual({
      documentId: 'doc-1',
      title: 'Auth Spec',
      relevance: 'high',
      relationship: 'confirms',
      summary: 'New input aligns with existing auth requirements',
    });

    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].type).toBe('recurring_pattern');
  });

  it('should filter out matches with invalid document IDs', async () => {
    const mockDocs = [
      { id: 'doc-1', title: 'Auth Spec', content: 'Auth content' },
    ];

    const aiResponse = JSON.stringify({
      matches: [
        {
          documentId: 'doc-1',
          title: 'Auth Spec',
          relevance: 'high',
          relationship: 'confirms',
          summary: 'Valid match',
        },
        {
          documentId: 'doc-fake',
          title: 'Fake Doc',
          relevance: 'medium',
          relationship: 'expands',
          summary: 'Invalid match — doc ID not in team',
        },
      ],
      signals: [],
    });

    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: aiResponse }],
    });

    const mockSelect = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(mockDocs),
      }),
    });

    vi.doMock('../../db/index.js', () => ({
      db: { select: mockSelect },
    }));
    vi.doMock('../../lib/config.js', () => ({
      config: { ANTHROPIC_API_KEY: 'test-key' },
    }));
    vi.doMock('@anthropic-ai/sdk', () => ({
      default: vi.fn().mockImplementation(() => ({
        messages: { create: mockCreate },
      })),
    }));

    const { contextMatchingService } = await import('../context-matching.service.js');
    const result = await contextMatchingService.findRelatedSpecs('some input', 'team-1');

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].documentId).toBe('doc-1');
  });

  it('should return empty results when AI returns invalid JSON', async () => {
    const mockDocs = [
      { id: 'doc-1', title: 'Auth Spec', content: 'Auth content' },
    ];

    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'This is not valid JSON at all' }],
    });

    const mockSelect = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(mockDocs),
      }),
    });

    vi.doMock('../../db/index.js', () => ({
      db: { select: mockSelect },
    }));
    vi.doMock('../../lib/config.js', () => ({
      config: { ANTHROPIC_API_KEY: 'test-key' },
    }));
    vi.doMock('@anthropic-ai/sdk', () => ({
      default: vi.fn().mockImplementation(() => ({
        messages: { create: mockCreate },
      })),
    }));

    const { contextMatchingService } = await import('../context-matching.service.js');
    const result = await contextMatchingService.findRelatedSpecs('some input', 'team-1');

    expect(result).toEqual({ matches: [], signals: [] });
  });

  it('should throw when ANTHROPIC_API_KEY is not configured', async () => {
    const mockDocs = [
      { id: 'doc-1', title: 'Auth Spec', content: 'Auth content' },
    ];

    const mockSelect = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(mockDocs),
      }),
    });

    vi.doMock('../../db/index.js', () => ({
      db: { select: mockSelect },
    }));
    vi.doMock('../../lib/config.js', () => ({
      config: { ANTHROPIC_API_KEY: undefined },
    }));
    vi.doMock('@anthropic-ai/sdk', () => ({
      default: vi.fn().mockImplementation(() => ({
        messages: { create: vi.fn() },
      })),
    }));

    const { contextMatchingService } = await import('../context-matching.service.js');

    await expect(
      contextMatchingService.findRelatedSpecs('some input', 'team-1'),
    ).rejects.toThrow('ANTHROPIC_API_KEY is not configured');
  });

  it('should filter out signals with invalid types', async () => {
    const mockDocs = [
      { id: 'doc-1', title: 'Auth Spec', content: 'Auth content' },
    ];

    const aiResponse = JSON.stringify({
      matches: [],
      signals: [
        {
          type: 'recurring_pattern',
          description: 'Valid signal',
          relatedDocIds: ['doc-1'],
        },
        {
          type: 'invalid_type',
          description: 'Invalid signal type',
          relatedDocIds: [],
        },
      ],
    });

    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: aiResponse }],
    });

    const mockSelect = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(mockDocs),
      }),
    });

    vi.doMock('../../db/index.js', () => ({
      db: { select: mockSelect },
    }));
    vi.doMock('../../lib/config.js', () => ({
      config: { ANTHROPIC_API_KEY: 'test-key' },
    }));
    vi.doMock('@anthropic-ai/sdk', () => ({
      default: vi.fn().mockImplementation(() => ({
        messages: { create: mockCreate },
      })),
    }));

    const { contextMatchingService } = await import('../context-matching.service.js');
    const result = await contextMatchingService.findRelatedSpecs('some input', 'team-1');

    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].type).toBe('recurring_pattern');
  });
});
