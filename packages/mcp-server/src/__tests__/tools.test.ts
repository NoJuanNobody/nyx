import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing the module under test
vi.mock('../search/search.service.js', () => ({
  performWebSearch: vi.fn(),
}));

vi.mock('../auth.js', () => ({
  apiRequest: vi.fn().mockResolvedValue({}),
}));

describe('executeTool', () => {
  let executeTool: typeof import('../tools.js').executeTool;
  let apiRequest: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const authMod = await import('../auth.js');
    apiRequest = authMod.apiRequest as ReturnType<typeof vi.fn>;
    apiRequest.mockResolvedValue({});
    const toolsMod = await import('../tools.js');
    executeTool = toolsMod.executeTool;
  });

  // ── Team tools ────────────────────────────────────────

  it('nyx_list_teams calls GET /api/teams', async () => {
    const mockTeams = [{ id: 't1', name: 'Team A', slug: 'team-a', role: 'owner' }];
    apiRequest.mockResolvedValue(mockTeams);

    const result = await executeTool('nyx_list_teams', {});
    expect(apiRequest).toHaveBeenCalledWith('/api/teams');
    expect(result).toEqual(mockTeams);
  });

  it('nyx_get_team calls GET /api/teams/:id', async () => {
    const mockTeam = { id: 't1', name: 'Team A', slug: 'team-a' };
    apiRequest.mockResolvedValue(mockTeam);

    const result = await executeTool('nyx_get_team', { team_id: 't1' });
    expect(apiRequest).toHaveBeenCalledWith('/api/teams/t1');
    expect(result).toEqual(mockTeam);
  });

  it('nyx_create_team calls POST /api/teams with name and slug', async () => {
    const mockTeam = { id: 't2', name: 'New Team', slug: 'new-team' };
    apiRequest.mockResolvedValue(mockTeam);

    const result = await executeTool('nyx_create_team', { name: 'New Team', slug: 'new-team' });
    expect(apiRequest).toHaveBeenCalledWith('/api/teams', {
      method: 'POST',
      body: JSON.stringify({ name: 'New Team', slug: 'new-team' }),
    });
    expect(result).toEqual(mockTeam);
  });

  // ── Document tools ────────────────────────────────────

  it('nyx_search_docs calls GET /api/documents?teamId=...', async () => {
    apiRequest.mockResolvedValue([]);
    await executeTool('nyx_search_docs', { team_id: 't1' });
    expect(apiRequest).toHaveBeenCalledWith('/api/documents?teamId=t1');
  });

  it('nyx_read_doc calls GET /api/documents/:id', async () => {
    const mockDoc = { id: 'd1', title: 'Doc', content: '# Hello' };
    apiRequest.mockResolvedValue(mockDoc);

    const result = await executeTool('nyx_read_doc', { document_id: 'd1' });
    expect(apiRequest).toHaveBeenCalledWith('/api/documents/d1');
    expect(result).toEqual(mockDoc);
  });

  it('nyx_create_doc calls POST /api/documents with correct body', async () => {
    apiRequest.mockResolvedValue({ id: 'd2' });

    await executeTool('nyx_create_doc', {
      team_id: 't1',
      title: 'New Doc',
      content: '# Content',
      path: '/api/auth',
    });

    expect(apiRequest).toHaveBeenCalledWith('/api/documents', {
      method: 'POST',
      body: JSON.stringify({
        teamId: 't1',
        title: 'New Doc',
        content: '# Content',
        path: '/api/auth',
      }),
    });
  });

  it('nyx_create_doc defaults path to / when not provided', async () => {
    apiRequest.mockResolvedValue({ id: 'd3' });

    await executeTool('nyx_create_doc', {
      team_id: 't1',
      title: 'Doc',
      content: 'body',
    });

    const call = apiRequest.mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.path).toBe('/');
  });

  it('nyx_update_doc calls PUT with only provided fields', async () => {
    apiRequest.mockResolvedValue({});

    await executeTool('nyx_update_doc', {
      document_id: 'd1',
      title: 'Updated Title',
    });

    expect(apiRequest).toHaveBeenCalledWith('/api/documents/d1', {
      method: 'PUT',
      body: JSON.stringify({ title: 'Updated Title' }),
    });
  });

  it('nyx_delete_doc calls DELETE /api/documents/:id', async () => {
    apiRequest.mockResolvedValue({ success: true });

    await executeTool('nyx_delete_doc', { document_id: 'd1' });
    expect(apiRequest).toHaveBeenCalledWith('/api/documents/d1', {
      method: 'DELETE',
    });
  });

  it('nyx_list_versions calls GET /api/documents/:id/versions', async () => {
    const mockVersions = [{ id: 'v1', version: 1, message: 'init', createdAt: '2025-01-01' }];
    apiRequest.mockResolvedValue(mockVersions);

    const result = await executeTool('nyx_list_versions', { document_id: 'd1' });
    expect(apiRequest).toHaveBeenCalledWith('/api/documents/d1/versions');
    expect(result).toEqual(mockVersions);
  });

  // ── Ticket tool ───────────────────────────────────────

  it('nyx_create_ticket calls POST /api/documents/:id/tickets', async () => {
    apiRequest.mockResolvedValue({ id: 'ticket-1' });

    await executeTool('nyx_create_ticket', {
      document_id: 'd1',
      provider: 'github',
      title: 'Bug fix',
      body: 'Fix the thing',
    });

    expect(apiRequest).toHaveBeenCalledWith('/api/documents/d1/tickets', {
      method: 'POST',
      body: JSON.stringify({
        provider: 'github',
        title: 'Bug fix',
        body: 'Fix the thing',
      }),
    });
  });

  // ── Timeline tool ─────────────────────────────────────

  it('nyx_get_timeline calls GET /api/documents/:id/timeline', async () => {
    apiRequest.mockResolvedValue([]);
    await executeTool('nyx_get_timeline', { document_id: 'd1' });
    expect(apiRequest).toHaveBeenCalledWith('/api/documents/d1/timeline');
  });

  // ── AI tools ──────────────────────────────────────────

  it('nyx_check_quality calls POST /api/ai/analyze', async () => {
    apiRequest.mockResolvedValue({ score: 8, suggestions: [] });

    await executeTool('nyx_check_quality', { content: '# Spec' });
    expect(apiRequest).toHaveBeenCalledWith('/api/ai/analyze', {
      method: 'POST',
      body: JSON.stringify({ content: '# Spec' }),
    });
  });

  it('nyx_detect_drift calls POST /api/ai/detect-drift', async () => {
    apiRequest.mockResolvedValue({ driftScore: 0.3 });

    await executeTool('nyx_detect_drift', {
      spec_content: 'spec',
      code_content: 'code',
    });

    expect(apiRequest).toHaveBeenCalledWith('/api/ai/detect-drift', {
      method: 'POST',
      body: JSON.stringify({ specContent: 'spec', codeContent: 'code' }),
    });
  });

  // ── Error handling ────────────────────────────────────

  it('throws for unknown tool name', async () => {
    await expect(executeTool('nyx_nonexistent', {})).rejects.toThrow('Unknown tool: nyx_nonexistent');
  });

  it('propagates API errors', async () => {
    apiRequest.mockRejectedValue(new Error('Nyx API error 401: Unauthorized'));

    await expect(executeTool('nyx_list_teams', {})).rejects.toThrow('Nyx API error 401');
  });
});

describe('TOOL_DEFINITIONS', () => {
  it('has unique tool names', async () => {
    const { TOOL_DEFINITIONS } = await import('../tools.js');
    const names = TOOL_DEFINITIONS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('all tools have required inputSchema type of object', async () => {
    const { TOOL_DEFINITIONS } = await import('../tools.js');
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('includes the new team, version, and delete tools', async () => {
    const { TOOL_DEFINITIONS } = await import('../tools.js');
    const names = TOOL_DEFINITIONS.map((t) => t.name);
    expect(names).toContain('nyx_list_teams');
    expect(names).toContain('nyx_get_team');
    expect(names).toContain('nyx_create_team');
    expect(names).toContain('nyx_delete_doc');
    expect(names).toContain('nyx_list_versions');
    expect(names).not.toContain('nyx_generate_podcast');
  });
});
