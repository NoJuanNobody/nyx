import { eq, and, desc, notInArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { changeProposals, documentVersions, documents } from '../db/schema.js';
import { aiService } from './ai.service.js';
import { ticketService } from './ticket.service.js';

export const changeProposalService = {
  async generate(documentId: string, teamId: string, userId: string) {
    // Find version IDs already used in previous proposals
    const existingProposals = await db
      .select({ sourceVersions: changeProposals.sourceVersions })
      .from(changeProposals)
      .where(eq(changeProposals.documentId, documentId));

    const usedVersionIds = new Set(
      existingProposals.flatMap((p) => p.sourceVersions as string[]),
    );

    // Get recent versions not yet included in a proposal
    const allVersions = await db
      .select()
      .from(documentVersions)
      .where(eq(documentVersions.documentId, documentId))
      .orderBy(desc(documentVersions.createdAt));

    const newVersions = allVersions.filter((v) => !usedVersionIds.has(v.id));

    if (newVersions.length === 0) {
      throw new Error('No new versions to analyze. All versions are already covered by existing proposals.');
    }

    // Get document title
    const [doc] = await db
      .select({ title: documents.title })
      .from(documents)
      .where(eq(documents.id, documentId));

    const analysis = await aiService.analyzeChangesForTickets(
      newVersions.map((v) => ({ version: v.version, message: v.message, content: v.content })),
      doc?.title ?? 'Untitled',
    );

    const [proposal] = await db
      .insert(changeProposals)
      .values({
        documentId,
        teamId,
        createdById: userId,
        title: analysis.title,
        description: analysis.description,
        suggestedTickets: analysis.suggestedTickets,
        sourceVersions: newVersions.map((v) => v.id),
      })
      .returning();

    return proposal;
  },

  async list(documentId: string, status?: string) {
    const rows = await db
      .select()
      .from(changeProposals)
      .where(eq(changeProposals.documentId, documentId))
      .orderBy(desc(changeProposals.createdAt));

    if (status) {
      return rows.filter((r) => r.status === status);
    }
    return rows;
  },

  async getById(id: string) {
    const [proposal] = await db
      .select()
      .from(changeProposals)
      .where(eq(changeProposals.id, id));
    return proposal ?? null;
  },

  async approve(proposalId: string, suggestedTickets?: Array<{ title: string; description: string; priority: string; labels: string[] }>) {
    const updates: Record<string, unknown> = { status: 'approved', updatedAt: new Date() };
    if (suggestedTickets) {
      updates.suggestedTickets = suggestedTickets;
    }
    const [updated] = await db
      .update(changeProposals)
      .set(updates)
      .where(eq(changeProposals.id, proposalId))
      .returning();
    return updated;
  },

  async reject(proposalId: string) {
    const [updated] = await db
      .update(changeProposals)
      .set({ status: 'rejected', updatedAt: new Date() })
      .where(eq(changeProposals.id, proposalId))
      .returning();
    return updated;
  },

  async push(proposalId: string, userId: string) {
    const proposal = await this.getById(proposalId);
    if (!proposal) throw new Error('Proposal not found');
    if (proposal.status !== 'approved') throw new Error('Proposal must be approved before pushing');

    const tickets = proposal.suggestedTickets as Array<{ title: string; description: string; priority: string; labels: string[] }>;

    const createdTickets = [];
    for (const ticket of tickets) {
      try {
        const created = await ticketService.createFromDocument(
          proposal.documentId,
          'github', // default to github; could be configurable
          ticket.title,
          ticket.description,
          userId,
        );
        createdTickets.push(created);
      } catch (err) {
        // Continue creating other tickets even if one fails
      }
    }

    const [updated] = await db
      .update(changeProposals)
      .set({ status: 'pushed', updatedAt: new Date() })
      .where(eq(changeProposals.id, proposalId))
      .returning();

    return { proposal: updated, createdTickets };
  },
};
