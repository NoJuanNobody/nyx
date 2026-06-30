import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing the module under test
vi.mock('../search/search.service.js', () => ({
  performWebSearch: vi.fn(),
}));

vi.mock('@nyx/harness-core', async (importOriginal) => {
  const original = await importOriginal<typeof import('@nyx/harness-core')>();
  return {
    ...original,
    executeTool: vi.fn().mockResolvedValue({}),
    NyxClient: vi.fn().mockImplementation(() => ({})),
  };
});

vi.mock('../auth.js', () => ({
  getConfig: vi.fn().mockReturnValue({ apiKey: 'test-key', baseUrl: 'http://api.test' }),
}));

describe('executeTool (mcp-server wrapper)', () => {
  let executeTool: typeof import('../tools.js').executeTool;
  let harnessExecuteTool: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const harnessMod = await import('@nyx/harness-core');
    harnessExecuteTool = harnessMod.executeTool as ReturnType<typeof vi.fn>;
    harnessExecuteTool.mockResolvedValue({});
    const toolsMod = await import('../tools.js');
    executeTool = toolsMod.executeTool;
  });

  // ── Team tools — delegated to harness-core ────────────────

  it('nyx_list_teams delegates to harness executeTool', async () => {
    const mockTeams = [{ id: 't1', name: 'Team A', slug: 'team-a', role: 'owner' }];
    harnessExecuteTool.mockResolvedValue(mockTeams);

    const result = await executeTool('nyx_list_teams', {});
    expect(harnessExecuteTool).toHaveBeenCalledWith('nyx_list_teams', {}, expect.anything());
    expect(result).toEqual(mockTeams);
  });

  it('nyx_get_team delegates to harness executeTool', async () => {
    await executeTool('nyx_get_team', { team_id: 't1' });
    expect(harnessExecuteTool).toHaveBeenCalledWith('nyx_get_team', { team_id: 't1' }, expect.anything());
  });

  it('nyx_create_team delegates to harness executeTool', async () => {
    await executeTool('nyx_create_team', { name: 'New Team', slug: 'new-team' });
    expect(harnessExecuteTool).toHaveBeenCalledWith(
      'nyx_create_team',
      { name: 'New Team', slug: 'new-team' },
      expect.anything(),
    );
  });

  // ── Document tools ────────────────────────────────────────

  it('nyx_search_docs delegates to harness executeTool', async () => {
    await executeTool('nyx_search_docs', { team_id: 't1' });
    expect(harnessExecuteTool).toHaveBeenCalledWith('nyx_search_docs', { team_id: 't1' }, expect.anything());
  });

  it('nyx_read_doc delegates to harness executeTool', async () => {
    await executeTool('nyx_read_doc', { document_id: 'd1' });
    expect(harnessExecuteTool).toHaveBeenCalledWith('nyx_read_doc', { document_id: 'd1' }, expect.anything());
  });

  it('nyx_create_doc delegates to harness executeTool', async () => {
    await executeTool('nyx_create_doc', {
      team_id: 't1',
      title: 'New Doc',
      content: '# Content',
      path: '/api/auth',
    });
    expect(harnessExecuteTool).toHaveBeenCalledWith(
      'nyx_create_doc',
      { team_id: 't1', title: 'New Doc', content: '# Content', path: '/api/auth' },
      expect.anything(),
    );
  });

  it('nyx_update_doc delegates to harness executeTool', async () => {
    await executeTool('nyx_update_doc', { document_id: 'd1', title: 'Updated Title' });
    expect(harnessExecuteTool).toHaveBeenCalledWith(
      'nyx_update_doc',
      { document_id: 'd1', title: 'Updated Title' },
      expect.anything(),
    );
  });

  it('nyx_delete_doc delegates to harness executeTool', async () => {
    await executeTool('nyx_delete_doc', { document_id: 'd1' });
    expect(harnessExecuteTool).toHaveBeenCalledWith('nyx_delete_doc', { document_id: 'd1' }, expect.anything());
  });

  it('nyx_list_versions delegates to harness executeTool', async () => {
    await executeTool('nyx_list_versions', { document_id: 'd1' });
    expect(harnessExecuteTool).toHaveBeenCalledWith('nyx_list_versions', { document_id: 'd1' }, expect.anything());
  });

  // ── Ticket tool ───────────────────────────────────────────

  it('nyx_create_ticket delegates to harness executeTool', async () => {
    await executeTool('nyx_create_ticket', {
      document_id: 'd1',
      provider: 'github',
      title: 'Bug fix',
      body: 'Fix the thing',
    });
    expect(harnessExecuteTool).toHaveBeenCalledWith(
      'nyx_create_ticket',
      { document_id: 'd1', provider: 'github', title: 'Bug fix', body: 'Fix the thing' },
      expect.anything(),
    );
  });

  // ── Timeline tool ─────────────────────────────────────────

  it('nyx_get_timeline delegates to harness executeTool', async () => {
    await executeTool('nyx_get_timeline', { document_id: 'd1' });
    expect(harnessExecuteTool).toHaveBeenCalledWith('nyx_get_timeline', { document_id: 'd1' }, expect.anything());
  });

  // ── AI tools ──────────────────────────────────────────────

  it('nyx_check_quality delegates to harness executeTool', async () => {
    await executeTool('nyx_check_quality', { content: '# Spec' });
    expect(harnessExecuteTool).toHaveBeenCalledWith('nyx_check_quality', { content: '# Spec' }, expect.anything());
  });

  it('nyx_detect_drift delegates to harness executeTool', async () => {
    await executeTool('nyx_detect_drift', { spec_content: 'spec', code_content: 'code' });
    expect(harnessExecuteTool).toHaveBeenCalledWith(
      'nyx_detect_drift',
      { spec_content: 'spec', code_content: 'code' },
      expect.anything(),
    );
  });

  // ── Error handling ────────────────────────────────────────

  it('throws for unknown tool name (via harness-core)', async () => {
    harnessExecuteTool.mockRejectedValue(new Error('Unknown tool: nyx_nonexistent'));
    await expect(executeTool('nyx_nonexistent', {})).rejects.toThrow('Unknown tool: nyx_nonexistent');
  });

  it('propagates errors from harness-core', async () => {
    harnessExecuteTool.mockRejectedValue(new Error('NyxClient GET /api/teams → 401: Unauthorized'));
    await expect(executeTool('nyx_list_teams', {})).rejects.toThrow('401');
  });
});

describe('TOOL_DEFINITIONS (re-exported from harness-core)', () => {
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

  it('includes the expected team, version, and delete tools', async () => {
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
