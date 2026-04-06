import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDb } from '../helpers/setup.js';

const mockAiService = vi.hoisted(() => ({
  analyzeSpecQuality: vi.fn().mockResolvedValue({ score: 8 }),
  detectDrift: vi.fn().mockResolvedValue({ hasDrift: false }),
}));
vi.mock('../../services/ai.service.js', () => ({ aiService: mockAiService }));

const mockTicketService = vi.hoisted(() => ({
  createFromDocument: vi.fn().mockResolvedValue({ id: 't-1', title: 'Ticket', externalUrl: 'url' }),
}));
vi.mock('../../services/ticket.service.js', () => ({ ticketService: mockTicketService }));

const mockAuditService = vi.hoisted(() => ({
  getTrailForDocument: vi.fn().mockResolvedValue([{ id: 'evt-1' }]),
}));
vi.mock('../../services/audit.service.js', () => ({ auditService: mockAuditService }));

const mockGithubService = vi.hoisted(() => ({
  getFileTree: vi.fn().mockResolvedValue([{ path: 'src/index.ts' }]),
  getFileContent: vi.fn().mockResolvedValue({ content: Buffer.from('file content').toString('base64') }),
}));
vi.mock('../../services/github.service.js', () => ({ githubService: mockGithubService }));

import { executeTool } from '../../services/agent/executor.js';
import type { AgentContext } from '../../services/agent/types.js';

const ctx: AgentContext = {
  userId: 'user-1',
  userRole: 'admin',
  teamId: 'team-1',
  sessionId: 'sess-1',
};

const viewerCtx: AgentContext = { ...ctx, userRole: 'viewer' };

describe('Agent Executor', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('read_document returns document data', async () => {
    const doc = { id: 'doc-1', title: 'Test', content: '# Hello', status: 'draft', path: '/' };
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([doc]),
        }),
      }),
    } as any);

    const result = await executeTool('read_document', { document_id: 'doc-1' }, ctx);
    expect(result).toEqual({ id: 'doc-1', title: 'Test', content: '# Hello', status: 'draft', path: '/' });
  });

  it('read_document throws if not found', async () => {
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as any);

    await expect(executeTool('read_document', { document_id: 'bad' }, ctx)).rejects.toThrow('Document not found');
  });

  it('list_documents returns documents', async () => {
    const docs = [{ id: 'doc-1', title: 'T', status: 'draft', path: '/' }];
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(docs),
      }),
    } as any);

    const result = await executeTool('list_documents', {}, ctx);
    expect(result).toEqual(docs);
  });

  it('update_document updates and returns doc', async () => {
    const updated = { id: 'doc-1', title: 'New', status: 'draft' };
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([updated]),
        }),
      }),
    } as any);

    const result = await executeTool('update_document', { document_id: 'doc-1', title: 'New' }, ctx);
    expect(result).toEqual({ id: 'doc-1', title: 'New', status: 'draft' });
  });

  it('update_document throws for viewer role', async () => {
    await expect(
      executeTool('update_document', { document_id: 'doc-1', title: 'New' }, viewerCtx),
    ).rejects.toThrow('Permission denied');
  });

  it('get_version_diff returns diff', async () => {
    const vA = { version: 1, content: 'A' };
    const vB = { version: 2, content: 'B' };
    let callNum = 0;
    mockDb.select.mockImplementation(() => {
      callNum++;
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([callNum === 1 ? vA : vB]),
          }),
        }),
      } as any;
    });

    const result = await executeTool('get_version_diff', { version_id_a: 'a', version_id_b: 'b' }, ctx) as any;
    expect(result.a.content).toBe('A');
    expect(result.b.content).toBe('B');
  });

  it('analyze_spec_quality delegates to aiService', async () => {
    const result = await executeTool('analyze_spec_quality', { content: '# Spec' }, ctx);
    expect(result).toEqual({ score: 8 });
    expect(mockAiService.analyzeSpecQuality).toHaveBeenCalledWith('# Spec');
  });

  it('detect_drift delegates to aiService', async () => {
    const result = await executeTool('detect_drift', { spec_content: 'spec', code_content: 'code' }, ctx);
    expect(result).toEqual({ hasDrift: false });
  });

  it('get_github_files returns file tree', async () => {
    const integration = { config: { accessToken: 'ghp_test', owner: 'org', repo: 'repo' } };
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([integration]),
        }),
      }),
    } as any);

    const result = await executeTool('get_github_files', { team_id: 'team-1' }, ctx);
    expect(mockGithubService.getFileTree).toHaveBeenCalled();
  });

  it('get_github_files with path returns file content', async () => {
    const integration = { config: { accessToken: 'ghp_test', owner: 'org', repo: 'repo' } };
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([integration]),
        }),
      }),
    } as any);

    const result = await executeTool('get_github_files', { team_id: 'team-1', path: 'src/index.ts' }, ctx) as any;
    expect(result.content).toBe('file content');
  });

  it('get_github_files throws without integration', async () => {
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as any);

    await expect(executeTool('get_github_files', { team_id: 'team-1' }, ctx)).rejects.toThrow('No GitHub integration');
  });

  it('create_ticket creates and returns ticket', async () => {
    const result = await executeTool('create_ticket', {
      document_id: 'doc-1', provider: 'github', title: 'Fix', body: 'desc',
    }, ctx) as any;
    expect(result.id).toBe('t-1');
    expect(mockTicketService.createFromDocument).toHaveBeenCalled();
  });

  it('create_ticket throws for viewer role', async () => {
    await expect(
      executeTool('create_ticket', { document_id: 'doc-1', provider: 'github', title: 'Fix', body: 'desc' }, viewerCtx),
    ).rejects.toThrow('Permission denied');
  });

  it('search_audit_trail returns events', async () => {
    const result = await executeTool('search_audit_trail', { document_id: 'doc-1' }, ctx) as any[];
    expect(result).toHaveLength(1);
  });

  it('throws for unknown tool', async () => {
    await expect(executeTool('nonexistent', {}, ctx)).rejects.toThrow('Unknown tool');
  });
});
