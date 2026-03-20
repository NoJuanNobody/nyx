import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../auth.js', () => ({
  apiRequest: vi.fn().mockResolvedValue([]),
}));

describe('resolveResource', () => {
  let resolveResource: typeof import('../resources.js').resolveResource;
  let apiRequest: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const authMod = await import('../auth.js');
    apiRequest = authMod.apiRequest as ReturnType<typeof vi.fn>;
    const resMod = await import('../resources.js');
    resolveResource = resMod.resolveResource;
  });

  // ── Teams resources ───────────────────────────────────

  it('nyx://teams returns team list as JSON', async () => {
    const mockTeams = [{ id: 't1', name: 'Team A', slug: 'team-a', role: 'owner' }];
    apiRequest.mockResolvedValue(mockTeams);

    const result = await resolveResource('nyx://teams');
    expect(apiRequest).toHaveBeenCalledWith('/api/teams');
    expect(result.mimeType).toBe('application/json');
    expect(JSON.parse(result.content)).toEqual(mockTeams);
  });

  it('nyx://teams/{id} returns team details as JSON', async () => {
    const mockTeam = { id: 't1', name: 'Team A', slug: 'team-a' };
    apiRequest.mockResolvedValue(mockTeam);

    const result = await resolveResource('nyx://teams/t1');
    expect(apiRequest).toHaveBeenCalledWith('/api/teams/t1');
    expect(result.mimeType).toBe('application/json');
    expect(JSON.parse(result.content)).toEqual(mockTeam);
  });

  // ── Document resources ────────────────────────────────

  it('nyx://docs returns document list as JSON', async () => {
    const mockDocs = [{ id: 'd1', title: 'Doc', path: '/', status: 'active' }];
    apiRequest.mockResolvedValue(mockDocs);

    const result = await resolveResource('nyx://docs');
    expect(apiRequest).toHaveBeenCalledWith('/api/documents');
    expect(result.mimeType).toBe('application/json');
    expect(JSON.parse(result.content)).toEqual(mockDocs);
  });

  it('nyx://docs/{id} returns document as markdown', async () => {
    const mockDoc = { id: 'd1', title: 'My Doc', content: 'Hello world', path: '/', status: 'active' };
    apiRequest.mockResolvedValue(mockDoc);

    const result = await resolveResource('nyx://docs/d1');
    expect(apiRequest).toHaveBeenCalledWith('/api/documents/d1');
    expect(result.mimeType).toBe('text/markdown');
    expect(result.content).toBe('# My Doc\n\nHello world');
  });

  it('nyx://docs/{id}/versions returns version list as JSON', async () => {
    const mockVersions = [{ id: 'v1', version: 1, message: 'init', createdAt: '2025-01-01' }];
    apiRequest.mockResolvedValue(mockVersions);

    const result = await resolveResource('nyx://docs/d1/versions');
    expect(apiRequest).toHaveBeenCalledWith('/api/documents/d1/versions');
    expect(result.mimeType).toBe('application/json');
    expect(JSON.parse(result.content)).toEqual(mockVersions);
  });

  // ── Error handling ────────────────────────────────────

  it('throws for unknown URI', async () => {
    await expect(resolveResource('nyx://unknown')).rejects.toThrow('Unknown resource URI');
  });

  it('propagates API errors', async () => {
    apiRequest.mockRejectedValue(new Error('Network error'));
    await expect(resolveResource('nyx://teams')).rejects.toThrow('Network error');
  });
});

describe('RESOURCE_TEMPLATES', () => {
  it('includes team resource templates', async () => {
    const { RESOURCE_TEMPLATES } = await import('../resources.js');
    const uris = RESOURCE_TEMPLATES.map((r) => r.uriTemplate);
    expect(uris).toContain('nyx://teams');
    expect(uris).toContain('nyx://teams/{id}');
  });

  it('all templates have required fields', async () => {
    const { RESOURCE_TEMPLATES } = await import('../resources.js');
    for (const template of RESOURCE_TEMPLATES) {
      expect(template.uriTemplate).toBeTruthy();
      expect(template.name).toBeTruthy();
      expect(template.description).toBeTruthy();
      expect(template.mimeType).toBeTruthy();
    }
  });
});
