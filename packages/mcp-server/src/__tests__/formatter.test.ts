import { describe, it, expect } from 'vitest';
import { formatToolResult } from '../formatter.js';

describe('formatToolResult', () => {
  // ── Pass-through cases ───────────────────────────────────

  it('returns strings unchanged', () => {
    expect(formatToolResult('nyx_read_doc', 'already a string')).toBe('already a string');
  });

  it('returns (no result) for null', () => {
    expect(formatToolResult('nyx_read_doc', null)).toBe('(no result)');
  });

  // ── nyx_search_docs ──────────────────────────────────────

  it('nyx_search_docs: formats array of documents', () => {
    const result = [
      { id: 'd1', title: 'Auth Spec', path: '/api/auth', status: 'draft' },
      { id: 'd2', title: 'Billing', path: '/billing', status: 'published' },
    ];
    const out = formatToolResult('nyx_search_docs', result);
    expect(out).toContain('2 documents');
    expect(out).toContain('Auth Spec');
    expect(out).toContain('[draft]');
    expect(out).toContain('/api/auth');
    expect(out).not.toContain('"id"');
  });

  it('nyx_search_docs: handles empty list', () => {
    expect(formatToolResult('nyx_search_docs', [])).toBe('No documents found.');
  });

  // ── nyx_read_doc ─────────────────────────────────────────

  it('nyx_read_doc: renders title header + content, no JSON', () => {
    const result = {
      id: 'd1',
      title: 'Auth Spec',
      status: 'draft',
      path: '/api/auth',
      content: '## Overview\n\nThis is the spec.',
    };
    const out = formatToolResult('nyx_read_doc', result);
    expect(out).toContain('# Auth Spec');
    expect(out).toContain('· draft');
    expect(out).toContain('· /api/auth');
    expect(out).toContain('## Overview');
    expect(out).toContain('This is the spec.');
    expect(out).not.toContain('"id"');
  });

  it('nyx_read_doc: preserves full document content', () => {
    const longContent = '# Long\n' + 'word '.repeat(300);
    const result = { id: 'd1', title: 'Big Doc', content: longContent };
    const out = formatToolResult('nyx_read_doc', result);
    expect(out).toContain(longContent);
  });

  // ── nyx_create_doc ───────────────────────────────────────

  it('nyx_create_doc: shows created title and id', () => {
    const out = formatToolResult('nyx_create_doc', { id: 'd99', title: 'New Spec', path: '/api/new' });
    expect(out).toContain('created');
    expect(out).toContain('New Spec');
    expect(out).toContain('d99');
  });

  // ── nyx_update_doc ───────────────────────────────────────

  it('nyx_update_doc: shows updated and id', () => {
    const out = formatToolResult('nyx_update_doc', { id: 'd1', title: 'Renamed' });
    expect(out).toContain('updated');
    expect(out).toContain('d1');
  });

  // ── nyx_delete_doc ───────────────────────────────────────

  it('nyx_delete_doc: shows deleted on success', () => {
    expect(formatToolResult('nyx_delete_doc', { success: true })).toBe('Document deleted.');
  });

  // ── nyx_list_versions ────────────────────────────────────

  it('nyx_list_versions: formats version list', () => {
    const result = [
      { id: 'v1', version: 1, message: 'Initial draft', createdAt: '2025-01-01T00:00:00Z' },
      { id: 'v2', version: 2, message: 'Added auth section', createdAt: '2025-02-01T00:00:00Z' },
    ];
    const out = formatToolResult('nyx_list_versions', result);
    expect(out).toContain('2 versions');
    expect(out).toContain('v1');
    expect(out).toContain('Initial draft');
    expect(out).toContain('2025-01-01');
    expect(out).not.toContain('"id"');
  });

  // ── nyx_get_timeline ─────────────────────────────────────

  it('nyx_get_timeline: formats events, no JSON', () => {
    const result = [
      { type: 'doc_created', actor: 'alice', description: 'Created the doc', createdAt: '2025-01-01T00:00:00Z' },
      { type: 'ticket_created', actor: 'bob', description: 'Opened ticket #42', createdAt: '2025-01-02T00:00:00Z' },
    ];
    const out = formatToolResult('nyx_get_timeline', result);
    expect(out).toContain('2 events');
    expect(out).toContain('doc_created');
    expect(out).toContain('alice');
    expect(out).toContain('2025-01-01');
    expect(out).not.toContain('"type"');
  });

  // ── nyx_list_teams ───────────────────────────────────────

  it('nyx_list_teams: formats team list', () => {
    const result = [
      { id: 't1', name: 'Engineering', slug: 'eng', role: 'owner' },
      { id: 't2', name: 'Product', slug: 'product', role: 'member' },
    ];
    const out = formatToolResult('nyx_list_teams', result);
    expect(out).toContain('2 teams');
    expect(out).toContain('Engineering');
    expect(out).toContain('/eng');
    expect(out).toContain('owner');
    expect(out).not.toContain('"id"');
  });

  it('nyx_list_teams: empty list', () => {
    expect(formatToolResult('nyx_list_teams', [])).toBe('No teams found.');
  });

  // ── nyx_get_team ─────────────────────────────────────────

  it('nyx_get_team: shows name, slug, id', () => {
    const out = formatToolResult('nyx_get_team', { id: 't1', name: 'Engineering', slug: 'eng' });
    expect(out).toContain('Engineering');
    expect(out).toContain('/eng');
    expect(out).toContain('t1');
  });

  // ── nyx_check_quality ────────────────────────────────────

  it('nyx_check_quality: shows score and suggestions, no JSON', () => {
    const result = {
      score: 7,
      suggestions: ['Add more examples', 'Clarify the auth flow'],
    };
    const out = formatToolResult('nyx_check_quality', result);
    expect(out).toContain('7/10');
    expect(out).toContain('Add more examples');
    expect(out).toContain('Clarify the auth flow');
    expect(out).not.toContain('"score"');
  });

  // ── nyx_detect_drift ─────────────────────────────────────

  it('nyx_detect_drift: shows drift score, no JSON', () => {
    const result = { driftScore: 0.42, hasDrift: true, details: ['Auth endpoint changed'] };
    const out = formatToolResult('nyx_detect_drift', result);
    expect(out).toContain('0.42');
    expect(out).toContain('true');
    expect(out).toContain('Auth endpoint changed');
    expect(out).not.toContain('"driftScore"');
  });

  // ── nyx_web_search ───────────────────────────────────────

  it('nyx_web_search: formats results with title, url, snippet', () => {
    const result = {
      query: 'fastify rate limit',
      results: [
        { title: 'Fastify Rate Limit Plugin', url: 'https://example.com/rate', snippet: 'Adds rate limiting to Fastify.', source: 'web' },
        { title: 'Fastify Docs', url: 'https://fastify.dev', snippet: 'Official Fastify documentation.', source: 'web' },
      ],
      provider: 'brave',
      timestamp: '2025-01-01T00:00:00Z',
    };
    const out = formatToolResult('nyx_web_search', result);
    expect(out).toContain('fastify rate limit');
    expect(out).toContain('Fastify Rate Limit Plugin');
    expect(out).toContain('https://example.com/rate');
    expect(out).toContain('Adds rate limiting');
    expect(out).not.toContain('"provider"');
  });

  it('nyx_web_search: empty results', () => {
    const out = formatToolResult('nyx_web_search', { query: 'nothing', results: [], provider: 'brave', timestamp: '' });
    expect(out).toContain('No results');
  });

  // ── nyx_read_file ────────────────────────────────────────

  it('nyx_read_file: shows path header and content', () => {
    const result = { path: '/src/auth.ts', extension: 'ts', content: 'export function login() {}' };
    const out = formatToolResult('nyx_read_file', result);
    expect(out).toContain('/src/auth.ts');
    expect(out).toContain('ts');
    expect(out).toContain('export function login() {}');
    expect(out).not.toContain('"path"');
  });

  // ── nyx_list_files ───────────────────────────────────────

  it('nyx_list_files: formats directory entries', () => {
    const result = [
      { name: 'src', type: 'directory' },
      { name: 'package.json', type: 'file' },
    ];
    const out = formatToolResult('nyx_list_files', result);
    expect(out).toContain('src');
    expect(out).toContain('package.json');
    expect(out).not.toContain('"name"');
  });

  it('nyx_list_files: empty directory', () => {
    expect(formatToolResult('nyx_list_files', [])).toBe('(empty directory)');
  });

  // ── Meetings ─────────────────────────────────────────────

  it('nyx_join_meeting: shows session id and status', () => {
    const out = formatToolResult('nyx_join_meeting', { sessionId: 'sess-123', status: 'connecting' });
    expect(out).toContain('sess-123');
    expect(out).toContain('connecting');
  });

  it('nyx_leave_meeting: shows "Left meeting" on success', () => {
    expect(formatToolResult('nyx_leave_meeting', { success: true })).toBe('Left meeting.');
  });

  it('nyx_meeting_status: shows state and platform', () => {
    const out = formatToolResult('nyx_meeting_status', { state: 'in_call', platform: 'zoom', startedAt: '2025-01-01T12:00:00Z' });
    expect(out).toContain('in_call');
    expect(out).toContain('zoom');
    expect(out).toContain('2025-01-01');
  });

  // ── Unknown tool fallback ────────────────────────────────

  it('unknown tool falls back to JSON', () => {
    const result = { foo: 'bar' };
    const out = formatToolResult('nyx_nonexistent_tool', result);
    expect(out).toContain('"foo"');
    expect(out).toContain('"bar"');
  });
});
