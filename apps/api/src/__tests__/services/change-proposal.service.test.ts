import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDb } from '../helpers/setup.js';
import { makeChangeProposal, makeVersion, makeDocument } from '../helpers/factories.js';
import { changeProposalService } from '../../services/change-proposal.service.js';

vi.mock('../../services/ai.service.js', () => ({
  aiService: {
    analyzeChangesForTickets: vi.fn().mockResolvedValue({
      title: 'AI Proposal',
      description: 'AI generated description',
      suggestedTickets: [{ title: 'Ticket 1', description: 'Desc', priority: 'high', labels: ['bug'] }],
    }),
  },
}));

vi.mock('../../services/ticket.service.js', () => ({
  ticketService: {
    createFromDocument: vi.fn().mockResolvedValue({ id: 'ticket-1', title: 'Created Ticket' }),
  },
}));

describe('Change Proposal Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('generate: calls AI with accumulated versions, stores result', async () => {
    const docId = 'doc-1';
    const teamId = 'team-1';
    const version = makeVersion({ documentId: docId });
    const proposal = makeChangeProposal({ documentId: docId, teamId });

    // existing proposals (none)
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as any);

    // all versions
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockResolvedValue([version]),
        }),
      }),
    } as any);

    // document title
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ title: 'Test Doc' }]),
      }),
    } as any);

    // insert proposal
    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([proposal]),
      }),
    } as any);

    const { aiService } = await import('../../services/ai.service.js');
    const result = await changeProposalService.generate(docId, teamId, 'user-1');

    expect(aiService.analyzeChangesForTickets).toHaveBeenCalled();
    expect(result.id).toBe(proposal.id);
  });

  it('generate: excludes versions already used in prior proposals', async () => {
    const docId = 'doc-1';
    const v1 = makeVersion({ documentId: docId, version: 1 });
    const v2 = makeVersion({ documentId: docId, version: 2 });

    // existing proposals with v1 used
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ sourceVersions: [v1.id] }]),
      }),
    } as any);

    // all versions
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockResolvedValue([v1, v2]),
        }),
      }),
    } as any);

    // doc title
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ title: 'Doc' }]),
      }),
    } as any);

    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([makeChangeProposal()]),
      }),
    } as any);

    const { aiService } = await import('../../services/ai.service.js');
    await changeProposalService.generate(docId, 'team-1', 'user-1');

    // AI should only receive v2 (v1 was already used)
    const callArgs = (aiService.analyzeChangesForTickets as any).mock.calls[0][0];
    expect(callArgs).toHaveLength(1);
    expect(callArgs[0].version).toBe(v2.version);
  });

  it('approve: sets status to approved', async () => {
    const proposal = makeChangeProposal({ status: 'approved' });

    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([proposal]),
        }),
      }),
    } as any);

    const result = await changeProposalService.approve('proposal-1');
    expect(result.status).toBe('approved');
  });

  it('reject: sets status to rejected', async () => {
    const proposal = makeChangeProposal({ status: 'rejected' });

    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([proposal]),
        }),
      }),
    } as any);

    const result = await changeProposalService.reject('proposal-1');
    expect(result.status).toBe('rejected');
  });

  it('push: only works on approved proposals → creates tickets', async () => {
    const proposal = makeChangeProposal({ status: 'approved' });
    const pushedProposal = makeChangeProposal({ status: 'pushed' });

    // getById
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([proposal]),
      }),
    } as any);

    // update to pushed
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([pushedProposal]),
        }),
      }),
    } as any);

    const result = await changeProposalService.push(proposal.id, 'user-1');
    expect(result.proposal.status).toBe('pushed');
    expect(result.createdTickets).toBeDefined();
  });

  it('push: rejects non-approved proposals', async () => {
    const proposal = makeChangeProposal({ status: 'pending' });

    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([proposal]),
      }),
    } as any);

    await expect(
      changeProposalService.push(proposal.id, 'user-1'),
    ).rejects.toThrow('must be approved');
  });

  it('push: continues when individual ticket creation fails (fault tolerance)', async () => {
    const proposal = makeChangeProposal({
      status: 'approved',
      suggestedTickets: [
        { title: 'Ticket 1', description: 'D1', priority: 'high', labels: [] },
        { title: 'Ticket 2', description: 'D2', priority: 'low', labels: [] },
      ],
    });
    const pushedProposal = makeChangeProposal({ status: 'pushed' });

    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([proposal]),
      }),
    } as any);

    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([pushedProposal]),
        }),
      }),
    } as any);

    // Make first ticket creation fail, second succeed
    const { ticketService } = await import('../../services/ticket.service.js');
    (ticketService.createFromDocument as any)
      .mockRejectedValueOnce(new Error('GitHub API error'))
      .mockResolvedValueOnce({ id: 'ticket-2' });

    const result = await changeProposalService.push(proposal.id, 'user-1');
    // Should still complete and have the second ticket
    expect(result.proposal.status).toBe('pushed');
    expect(result.createdTickets).toHaveLength(1);
  });
});
