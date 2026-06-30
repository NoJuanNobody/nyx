import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TOOL_DEFINITIONS, executeTool, type ToolDefinition } from '../tools.js';
import { NyxClient } from '../client.js';

// Create a mock NyxClient
function makeMockClient() {
  return {
    get: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
    getTeamId: vi.fn().mockReturnValue(''),
    apiUrl: 'http://api.test',
    apiKey: 'sk-test',
  } as unknown as NyxClient;
}

describe('TOOL_DEFINITIONS', () => {
  it('is a non-empty array', () => {
    expect(Array.isArray(TOOL_DEFINITIONS)).toBe(true);
    expect(TOOL_DEFINITIONS.length).toBeGreaterThan(0);
  });

  it('has 20 tool definitions', () => {
    expect(TOOL_DEFINITIONS).toHaveLength(20);
  });

  it('each tool has name, description, and inputSchema fields', () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool).toHaveProperty('name');
      expect(tool).toHaveProperty('description');
      expect(tool).toHaveProperty('inputSchema');
      expect(typeof tool.name).toBe('string');
      expect(typeof tool.description).toBe('string');
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('all tool names are unique', () => {
    const names = TOOL_DEFINITIONS.map((t: ToolDefinition) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('contains the expected tool names', () => {
    const names = TOOL_DEFINITIONS.map((t: ToolDefinition) => t.name);
    const expectedTools = [
      'nyx_search_docs',
      'nyx_read_doc',
      'nyx_check_quality',
      'nyx_detect_drift',
      'nyx_create_doc',
      'nyx_update_doc',
      'nyx_create_ticket',
      'nyx_get_timeline',
      'nyx_list_teams',
      'nyx_get_team',
      'nyx_create_team',
      'nyx_delete_doc',
      'nyx_list_versions',
      'nyx_web_search',
      'nyx_join_meeting',
      'nyx_leave_meeting',
      'nyx_meeting_status',
      'nyx_generate_meeting_doc',
      'nyx_read_file',
      'nyx_list_files',
    ];
    for (const expected of expectedTools) {
      expect(names).toContain(expected);
    }
  });
});

describe('executeTool', () => {
  let client: NyxClient;

  beforeEach(() => {
    client = makeMockClient();
  });

  it('nyx_list_teams calls client.get("/api/teams")', async () => {
    const mockTeams = [{ id: 't1', name: 'Team A' }];
    (client.get as ReturnType<typeof vi.fn>).mockResolvedValue(mockTeams);

    const result = await executeTool('nyx_list_teams', {}, client);

    expect(client.get).toHaveBeenCalledWith('/api/teams');
    expect(result).toEqual(mockTeams);
  });

  it('nyx_get_team calls client.get("/api/teams/:id")', async () => {
    await executeTool('nyx_get_team', { team_id: 't1' }, client);
    expect(client.get).toHaveBeenCalledWith('/api/teams/t1');
  });

  it('nyx_create_team calls client.post("/api/teams") with name and slug', async () => {
    await executeTool('nyx_create_team', { name: 'New Team', slug: 'new-team' }, client);
    expect(client.post).toHaveBeenCalledWith('/api/teams', { name: 'New Team', slug: 'new-team' });
  });

  it('nyx_search_docs calls client.get with teamId query param', async () => {
    await executeTool('nyx_search_docs', { team_id: 't1' }, client);
    expect(client.get).toHaveBeenCalledWith('/api/documents?teamId=t1');
  });

  it('nyx_read_doc calls client.get("/api/documents/:id")', async () => {
    await executeTool('nyx_read_doc', { document_id: 'd1' }, client);
    expect(client.get).toHaveBeenCalledWith('/api/documents/d1');
  });

  it('nyx_create_doc calls client.post with body including default path', async () => {
    await executeTool('nyx_create_doc', { team_id: 't1', title: 'Doc', content: '# Hi' }, client);
    expect(client.post).toHaveBeenCalledWith('/api/documents', {
      teamId: 't1',
      title: 'Doc',
      content: '# Hi',
      path: '/',
    });
  });

  it('nyx_create_doc uses provided path when given', async () => {
    await executeTool(
      'nyx_create_doc',
      { team_id: 't1', title: 'Doc', content: '# Hi', path: '/api/auth' },
      client,
    );
    expect(client.post).toHaveBeenCalledWith('/api/documents', {
      teamId: 't1',
      title: 'Doc',
      content: '# Hi',
      path: '/api/auth',
    });
  });

  it('nyx_update_doc calls client.put with only provided fields', async () => {
    await executeTool('nyx_update_doc', { document_id: 'd1', title: 'New Title' }, client);
    expect(client.put).toHaveBeenCalledWith('/api/documents/d1', { title: 'New Title' });
  });

  it('nyx_delete_doc calls client.delete', async () => {
    await executeTool('nyx_delete_doc', { document_id: 'd1' }, client);
    expect(client.delete).toHaveBeenCalledWith('/api/documents/d1');
  });

  it('nyx_check_quality calls client.post("/api/ai/analyze")', async () => {
    await executeTool('nyx_check_quality', { content: '# Spec' }, client);
    expect(client.post).toHaveBeenCalledWith('/api/ai/analyze', { content: '# Spec' });
  });

  it('nyx_detect_drift calls client.post("/api/ai/detect-drift")', async () => {
    await executeTool(
      'nyx_detect_drift',
      { spec_content: 'spec', code_content: 'code' },
      client,
    );
    expect(client.post).toHaveBeenCalledWith('/api/ai/detect-drift', {
      specContent: 'spec',
      codeContent: 'code',
    });
  });

  it('nyx_list_versions calls client.get("/api/documents/:id/versions")', async () => {
    await executeTool('nyx_list_versions', { document_id: 'd1' }, client);
    expect(client.get).toHaveBeenCalledWith('/api/documents/d1/versions');
  });

  it('nyx_get_timeline calls client.get("/api/documents/:id/timeline")', async () => {
    await executeTool('nyx_get_timeline', { document_id: 'd1' }, client);
    expect(client.get).toHaveBeenCalledWith('/api/documents/d1/timeline');
  });

  it('throws for unknown tool name', async () => {
    await expect(executeTool('nyx_nonexistent', {}, client)).rejects.toThrow(
      'Unknown tool: nyx_nonexistent',
    );
  });

  it('propagates errors from client', async () => {
    (client.get as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('NyxClient GET /api/teams → 401: Unauthorized'),
    );
    await expect(executeTool('nyx_list_teams', {}, client)).rejects.toThrow('401');
  });
});
