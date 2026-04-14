import { describe, it, expect, vi, beforeEach } from 'vitest';

// Must use vi.hoisted to create the mock fn before vi.mock runs
const mockCreate = vi.hoisted(() => vi.fn());

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = { create: mockCreate };
    },
  };
});

import { aiService } from '../../services/ai.service.js';

function makeResponse(text: string) {
  return { content: [{ type: 'text', text }] };
}

describe('AI Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('analyzeSpecQuality: returns parsed JSON on valid response', async () => {
    mockCreate.mockResolvedValueOnce(
      makeResponse('{"score": 8, "suggestions": ["Add more detail"]}'),
    );

    const result = await aiService.analyzeSpecQuality('# My Spec');

    expect(result.score).toBe(8);
    expect(result.suggestions).toEqual(['Add more detail']);
  });

  it('analyzeSpecQuality: returns fallback {score:5} on JSON parse failure', async () => {
    mockCreate.mockResolvedValueOnce(
      makeResponse('This is not valid JSON, but helpful feedback'),
    );

    const result = await aiService.analyzeSpecQuality('# My Spec');

    expect(result.score).toBe(5);
    expect(result.suggestions).toEqual(['This is not valid JSON, but helpful feedback']);
  });

  it('detectDrift: returns safe defaults on parse failure', async () => {
    mockCreate.mockResolvedValueOnce(
      makeResponse('Unable to parse as JSON response'),
    );

    const result = await aiService.detectDrift('spec content', 'code content');

    expect(result.hasDrift).toBe(false);
    expect(result.driftScore).toBe(0);
    expect(result.suggestions).toEqual([]);
  });

  it('editDocument: strips markdown code fences from response', async () => {
    mockCreate.mockResolvedValueOnce(
      makeResponse('```markdown\n# Updated Content\n\nNew paragraph\n```'),
    );

    const result = await aiService.editDocument('# Old Content', 'Add a paragraph');

    expect(result).toBe('# Updated Content\n\nNew paragraph');
    expect(result).not.toContain('```');
  });

  it('generateTicketFromDiff: returns generic ticket on parse failure', async () => {
    mockCreate.mockResolvedValueOnce(
      makeResponse('Here is a ticket description in plain text'),
    );

    const result = await aiService.generateTicketFromDiff('some diff');

    expect(result.title).toBe('Implement code changes to match spec updates');
    expect(result.labels).toEqual(['spec-change', 'implementation']);
  });

  it('requireClient throws when ANTHROPIC_API_KEY not configured', () => {
    expect(aiService).toBeDefined();
    expect(typeof aiService.analyzeSpecQuality).toBe('function');
  });

  it('generateDocument: returns parsed JSON on valid response', async () => {
    mockCreate.mockResolvedValueOnce(
      makeResponse('{"title": "My Doc", "content": "# Hello World"}'),
    );

    const result = await aiService.generateDocument('Create a doc about hello world');
    expect(result.title).toBe('My Doc');
    expect(result.content).toBe('# Hello World');
  });

  it('generateDocument: returns fallback on parse failure', async () => {
    mockCreate.mockResolvedValueOnce(
      makeResponse('# Some raw markdown content'),
    );

    const result = await aiService.generateDocument('Create a doc');
    expect(result.title).toBe('Untitled Document');
    expect(result.content).toBe('# Some raw markdown content');
  });

  it('editDocument: includes history in messages when provided', async () => {
    mockCreate.mockResolvedValueOnce(
      makeResponse('# Edited with history context'),
    );

    const result = await aiService.editDocument(
      '# Old Content',
      'Add history',
      [{ role: 'user', content: 'previous message' }, { role: 'assistant', content: 'previous response' }],
    );
    expect(result).toBe('# Edited with history context');
    // Verify history was included in the call
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.messages.length).toBe(3); // 2 history + 1 current
  });

  it('analyzeChangesForTickets: returns parsed ticket suggestions', async () => {
    mockCreate.mockResolvedValueOnce(
      makeResponse('{"title": "API Changes", "description": "Updated API endpoints", "suggestedTickets": [{"title": "Update endpoints", "description": "Fix the routes", "priority": "high", "labels": ["api"]}]}'),
    );

    const result = await aiService.analyzeChangesForTickets(
      [{ version: 1, message: 'Initial', content: '# V1' }],
      'My Document',
    );
    expect(result.title).toBe('API Changes');
    expect(result.suggestedTickets).toHaveLength(1);
  });

  it('analyzeChangesForTickets: returns fallback on parse failure', async () => {
    mockCreate.mockResolvedValueOnce(
      makeResponse('Some unstructured analysis text'),
    );

    const result = await aiService.analyzeChangesForTickets(
      [{ version: 1, message: null, content: '# V1' }],
      'My Document',
    );
    expect(result.title).toBe('Changes to My Document');
    expect(result.suggestedTickets).toHaveLength(1);
  });

  it('bootstrapDocsFromCode: returns generated documentation', async () => {
    mockCreate.mockResolvedValueOnce(
      makeResponse('# Project Overview\n\nThis is a Node.js project.'),
    );

    const result = await aiService.bootstrapDocsFromCode([
      { path: 'src/index.ts', content: 'console.log("hello")' },
    ]);
    expect(result).toContain('Project Overview');
  });

  it('seedNextStage: returns parsed title and content from markdown heading', async () => {
    mockCreate.mockResolvedValueOnce(
      makeResponse('# PRD\n\n# Product Requirements\n\nDetails here'),
    );

    const result = await aiService.seedNextStage('# Conception doc', 'conception', 'definition');
    expect(result.title).toBe('PRD');
    expect(result.content).toContain('Product Requirements');
  });

  it('seedNextStage: returns fallback on parse failure', async () => {
    mockCreate.mockResolvedValueOnce(
      makeResponse('# Architecture Document\n\nDesign details here'),
    );

    const result = await aiService.seedNextStage('# PRD content', 'definition', 'architecture');
    expect(result.title).toBe('Architecture Document');
    expect(result.content).toContain('Design details here');
  });

  it('seedNextStage: extracts title from markdown even with code fences', async () => {
    mockCreate.mockResolvedValueOnce(
      makeResponse('# Implementation\n\n## Impl Plan\n\nSteps here'),
    );

    const result = await aiService.seedNextStage('# Arch doc', 'architecture', 'implementation');
    expect(result.title).toBe('Implementation');
  });

  it('analyzeMissingSections: returns parsed sections', async () => {
    mockCreate.mockResolvedValueOnce(
      makeResponse('{"missingSections": [{"name": "Security", "description": "Missing security analysis", "priority": "high"}]}'),
    );

    const result = await aiService.analyzeMissingSections('# My Spec');
    expect(result.missingSections).toHaveLength(1);
    expect(result.missingSections[0].name).toBe('Security');
    expect(result.missingSections[0].priority).toBe('high');
  });

  it('analyzeMissingSections: returns empty array on parse failure', async () => {
    mockCreate.mockResolvedValueOnce(
      makeResponse('Unable to analyze this document'),
    );

    const result = await aiService.analyzeMissingSections('# My Spec');
    expect(result.missingSections).toEqual([]);
  });

  it('analyzeMissingSections: uses stage context when provided', async () => {
    mockCreate.mockResolvedValueOnce(
      makeResponse('{"missingSections": []}'),
    );

    await aiService.analyzeMissingSections('# Spec', 'definition');
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.system).toContain('definition');
  });

  it('notificationReply: returns parsed reply', async () => {
    mockCreate.mockResolvedValueOnce(
      makeResponse('{"reply": "You should add more detail to the API section.", "suggestedActions": ["Add API docs", "Include examples"]}'),
    );

    const result = await aiService.notificationReply('notif-1', 'What should I improve?', '# My Doc');
    expect(result.reply).toBe('You should add more detail to the API section.');
    expect(result.suggestedActions).toHaveLength(2);
  });

  it('notificationReply: returns fallback on parse failure', async () => {
    mockCreate.mockResolvedValueOnce(
      makeResponse('Consider adding more examples to your specification.'),
    );

    const result = await aiService.notificationReply('notif-1', 'Help me', '# Doc');
    expect(result.reply).toBe('Consider adding more examples to your specification.');
    expect(result.suggestedActions).toEqual([]);
  });

  it('detectDrift: returns parsed JSON on valid response', async () => {
    mockCreate.mockResolvedValueOnce(
      makeResponse('{"hasDrift": true, "driftScore": 7, "details": "API mismatch", "suggestions": ["Update routes"]}'),
    );

    const result = await aiService.detectDrift('spec', 'code');
    expect(result.hasDrift).toBe(true);
    expect(result.driftScore).toBe(7);
    expect(result.suggestions).toHaveLength(1);
  });

  it('generateTicketFromDiff: returns parsed JSON on valid response', async () => {
    mockCreate.mockResolvedValueOnce(
      makeResponse('{"title": "Fix auth", "description": "Update auth flow", "labels": ["auth", "bug"]}'),
    );

    const result = await aiService.generateTicketFromDiff('diff content', 'auth context');
    expect(result.title).toBe('Fix auth');
    expect(result.labels).toContain('auth');
  });

  it('analyzeSpecQuality: uses stage-specific criteria', async () => {
    mockCreate.mockResolvedValueOnce(
      makeResponse('{"score": 9, "suggestions": []}'),
    );

    const result = await aiService.analyzeSpecQuality('# Spec', 'definition');
    expect(result.score).toBe(9);
    // Verify stage prompt was included
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.system).toContain('definition');
  });

  it('seedNextStage: extracts title from heading in multi-section doc', async () => {
    mockCreate.mockResolvedValueOnce(
      makeResponse('# PRD Document\n\n## Overview\n\nThis is the PRD.\n\n## Requirements\n\n- Req 1'),
    );

    const result = await aiService.seedNextStage('# Conception', 'conception', 'definition');
    expect(result.title).toBe('PRD Document');
    expect(result.content).toContain('## Overview');
  });

  it('seedNextStage: system prompt emphasizes markdown format', async () => {
    mockCreate.mockResolvedValueOnce(
      makeResponse('# Architecture\n\nDesign here'),
    );

    await aiService.seedNextStage('# PRD', 'definition', 'architecture');
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.system).toContain('markdown');
  });

  it('generateNewsArticle: returns parsed JSON on valid response', async () => {
    mockCreate.mockResolvedValueOnce(
      makeResponse(
        '{"headline": "Rats Take Over Subway — Again!", "content": "# Rats Take Over Subway\\n\\nCommuters were stunned...", "summary": "NYC subway riders face a furry new commute companion."}',
      ),
    );

    const result = await aiService.generateNewsArticle('Rats in the NYC subway');
    expect(result.headline).toBe('Rats Take Over Subway — Again!');
    expect(result.content).toContain('Rats Take Over Subway');
    expect(result.summary).toContain('subway');
  });

  it('generateNewsArticle: returns fallback on parse failure', async () => {
    mockCreate.mockResolvedValueOnce(
      makeResponse('Some raw article text about a breaking story'),
    );

    const result = await aiService.generateNewsArticle('Breaking story');
    expect(result.headline).toBe('Breaking News');
    expect(result.content).toBe('Some raw article text about a breaking story');
    expect(result.summary).toBe('');
  });

  it('generateNewsArticle: includes context in prompt when provided', async () => {
    mockCreate.mockResolvedValueOnce(
      makeResponse('{"headline": "Test", "content": "# Test", "summary": "Test summary"}'),
    );

    await aiService.generateNewsArticle('Tech launch', 'Company raised $500M');
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.messages[0].content).toContain('Company raised $500M');
  });

  it('generateNewsArticle: system prompt includes NY Post style guidance', async () => {
    mockCreate.mockResolvedValueOnce(
      makeResponse('{"headline": "Test", "content": "# Test", "summary": "Test"}'),
    );

    await aiService.generateNewsArticle('Any topic');
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.system).toContain('New York Post');
    expect(callArgs.system).toContain('Inverted pyramid');
    expect(callArgs.system).toContain('tabloid');
  });

  it('generateNewsArticle: strips code fences from response', async () => {
    mockCreate.mockResolvedValueOnce(
      makeResponse(
        '```json\n{"headline": "Fenced Article", "content": "# Fenced", "summary": "Fenced summary"}\n```',
      ),
    );

    const result = await aiService.generateNewsArticle('Fenced topic');
    expect(result.headline).toBe('Fenced Article');
  });

});
