import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDb, mockFetch } from '../helpers/setup.js';
import { makeDocument, makeIntegration, makeTicket } from '../helpers/factories.js';
import { ticketService } from '../../services/ticket.service.js';

// Mock dependent services
vi.mock('../../services/github.service.js', () => ({
  githubService: {
    createIssue: vi.fn().mockResolvedValue({ number: 42, html_url: 'https://github.com/org/repo/issues/42' }),
  },
}));

vi.mock('../../services/jira.service.js', () => ({
  jiraService: {
    createIssue: vi.fn().mockResolvedValue({ key: 'PROJ-123', self: 'https://jira.example.com/rest/api/2/issue/PROJ-123' }),
    getIssue: vi.fn(),
  },
}));

vi.mock('../../services/audit.service.js', () => ({
  auditService: {
    recordEvent: vi.fn().mockResolvedValue({}),
  },
}));

describe('Ticket Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('createFromDocument: GitHub path extracts owner/repo from selectedRepos[0]', async () => {
    const doc = makeDocument();
    const integration = makeIntegration({
      teamId: doc.teamId,
      config: {
        accessToken: 'ghp_token',
        selectedRepos: [{ owner: 'myorg', name: 'myrepo', fullName: 'myorg/myrepo' }],
      },
    });
    const ticket = makeTicket({ documentId: doc.id });

    // doc lookup
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ teamId: doc.teamId }]),
      }),
    } as any);

    // integration lookup
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([integration]),
      }),
    } as any);

    // insert ticket
    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([ticket]),
      }),
    } as any);

    const { githubService } = await import('../../services/github.service.js');
    const result = await ticketService.createFromDocument(doc.id, 'github', 'Title', 'Body', 'user-1');

    expect(githubService.createIssue).toHaveBeenCalledWith('ghp_token', 'myorg', 'myrepo', 'Title', 'Body');
    expect(result.id).toBe(ticket.id);
  });

  it('createFromDocument: explicit repo param overrides selectedRepos[0]', async () => {
    const doc = makeDocument();
    const integration = makeIntegration({
      teamId: doc.teamId,
      config: {
        accessToken: 'ghp_token',
        selectedRepos: [{ owner: 'myorg', name: 'defaultrepo', fullName: 'myorg/defaultrepo' }],
      },
    });
    const ticket = makeTicket({ documentId: doc.id });

    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ teamId: doc.teamId }]),
      }),
    } as any);

    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([integration]),
      }),
    } as any);

    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([ticket]),
      }),
    } as any);

    const { githubService } = await import('../../services/github.service.js');
    await ticketService.createFromDocument(doc.id, 'github', 'Title', 'Body', 'user-1', {
      owner: 'otherorg',
      name: 'otherrepo',
    });

    expect(githubService.createIssue).toHaveBeenCalledWith('ghp_token', 'otherorg', 'otherrepo', 'Title', 'Body');
  });

  it('createFromDocument: falls back to legacy owner/repo config fields', async () => {
    const doc = makeDocument();
    const integration = makeIntegration({
      teamId: doc.teamId,
      config: { accessToken: 'ghp_token', owner: 'legacyowner', repo: 'legacyrepo' },
    });
    const ticket = makeTicket();

    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ teamId: doc.teamId }]),
      }),
    } as any);

    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([integration]),
      }),
    } as any);

    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([ticket]),
      }),
    } as any);

    const { githubService } = await import('../../services/github.service.js');
    await ticketService.createFromDocument(doc.id, 'github', 'Title', 'Body', 'user-1');

    expect(githubService.createIssue).toHaveBeenCalledWith('ghp_token', 'legacyowner', 'legacyrepo', 'Title', 'Body');
  });

  it('createFromDocument: throws when no integration found for team', async () => {
    const doc = makeDocument();

    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ teamId: doc.teamId }]),
      }),
    } as any);

    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as any);

    await expect(
      ticketService.createFromDocument(doc.id, 'github', 'Title', 'Body', 'user-1'),
    ).rejects.toThrow('No github integration configured');
  });

  it('createFromDocument: Jira path constructs correct payload', async () => {
    const doc = makeDocument();
    const integration = makeIntegration({
      teamId: doc.teamId,
      type: 'jira',
      config: { baseUrl: 'https://jira.example.com', email: 'j@test.com', apiToken: 'jira-token', projectKey: 'PROJ' },
    });
    const ticket = makeTicket({ provider: 'jira' });

    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ teamId: doc.teamId }]),
      }),
    } as any);

    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([integration]),
      }),
    } as any);

    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([ticket]),
      }),
    } as any);

    const { jiraService } = await import('../../services/jira.service.js');
    await ticketService.createFromDocument(doc.id, 'jira', 'Jira Title', 'Jira Body', 'user-1');

    expect(jiraService.createIssue).toHaveBeenCalledWith(
      'https://jira.example.com', 'j@test.com', 'jira-token',
      expect.objectContaining({ projectKey: 'PROJ', summary: 'Jira Title' }),
    );
  });

  it('syncStatus: maps GitHub open → open, closed → closed', async () => {
    const ticket = makeTicket({ provider: 'github', externalId: '10' });
    const doc = makeDocument();
    const integration = makeIntegration({ teamId: doc.teamId });

    // ticket lookup
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([ticket]),
      }),
    } as any);

    // doc lookup for teamId
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ teamId: doc.teamId }]),
      }),
    } as any);

    // integration lookup
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([integration]),
      }),
    } as any);

    // Mock GitHub API response
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ state: 'closed' }),
    } as any);

    // update ticket
    const updatedTicket = { ...ticket, status: 'closed' };
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([updatedTicket]),
        }),
      }),
    } as any);

    const result = await ticketService.syncStatus(ticket.id);
    expect(result.status).toBe('closed');
  });

  it('syncStatus: maps Jira Done → closed, In Progress → in_progress', async () => {
    const ticket = makeTicket({ provider: 'jira', externalId: 'PROJ-1' });
    const doc = makeDocument();
    const integration = makeIntegration({ teamId: doc.teamId, type: 'jira', config: { baseUrl: 'https://jira.test.com', email: 'a@b.com', apiToken: 'tok' } });

    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([ticket]),
      }),
    } as any);

    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ teamId: doc.teamId }]),
      }),
    } as any);

    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([integration]),
      }),
    } as any);

    const { jiraService } = await import('../../services/jira.service.js');
    (jiraService.getIssue as any).mockResolvedValueOnce({
      fields: { status: { name: 'Done' } },
    });

    const updatedTicket = { ...ticket, status: 'closed' };
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([updatedTicket]),
        }),
      }),
    } as any);

    const result = await ticketService.syncStatus(ticket.id);
    expect(result.status).toBe('closed');
  });

  it('listByTeam: returns tickets with documentTitle attached', async () => {
    const teamId = 'team-1';
    const doc = makeDocument({ teamId, title: 'My Doc' });
    const ticket = makeTicket({ documentId: doc.id });

    // team docs lookup
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ id: doc.id, title: doc.title }]),
      }),
    } as any);

    // tickets lookup
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([ticket]),
      }),
    } as any);

    const result = await ticketService.listByTeam(teamId);
    expect(result[0]).toHaveProperty('documentTitle', 'My Doc');
  });

  it('listByTeam: filters by status and provider', async () => {
    const teamId = 'team-1';
    const doc = makeDocument({ teamId });
    const ghTicket = makeTicket({ documentId: doc.id, provider: 'github', status: 'open' });
    const jiraTicket = makeTicket({ documentId: doc.id, provider: 'jira', status: 'closed' });

    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ id: doc.id, title: doc.title }]),
      }),
    } as any);

    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([ghTicket, jiraTicket]),
      }),
    } as any);

    const result = await ticketService.listByTeam(teamId, { provider: 'github' });
    expect(result).toHaveLength(1);
    expect(result[0].provider).toBe('github');
  });
});
