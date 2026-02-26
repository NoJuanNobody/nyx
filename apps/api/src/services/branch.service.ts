import { eq, and, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { documentBranches, documents, documentVersions } from '../db/schema.js';
import { versionService } from './version.service.js';

export const branchService = {
  async create(data: {
    documentId: string;
    name: string;
    baseVersionId: string;
    createdById: string;
  }) {
    // Get the base version content
    const baseVersion = await versionService.getById(data.baseVersionId);
    if (!baseVersion) throw new Error('Base version not found');

    const [branch] = await db
      .insert(documentBranches)
      .values({
        documentId: data.documentId,
        name: data.name,
        baseVersionId: data.baseVersionId,
        content: baseVersion.content,
        createdById: data.createdById,
        status: 'draft',
      })
      .returning();

    return branch;
  },

  async listByDocument(documentId: string) {
    return db
      .select()
      .from(documentBranches)
      .where(eq(documentBranches.documentId, documentId));
  },

  async getById(branchId: string) {
    const [branch] = await db
      .select()
      .from(documentBranches)
      .where(eq(documentBranches.id, branchId));

    return branch ?? null;
  },

  async updateContent(branchId: string, content: string) {
    const [branch] = await db
      .update(documentBranches)
      .set({ content })
      .where(eq(documentBranches.id, branchId))
      .returning();

    return branch;
  },

  async diff(branchId: string) {
    const branch = await this.getById(branchId);
    if (!branch) throw new Error('Branch not found');

    const baseVersion = await versionService.getById(branch.baseVersionId);
    if (!baseVersion) throw new Error('Base version not found');

    return {
      branchContent: branch.content,
      baseContent: baseVersion.content,
      branchName: branch.name,
      baseVersion: baseVersion.version,
    };
  },

  async approve(branchId: string, reviewerId: string) {
    const branch = await this.getById(branchId);
    if (!branch) throw new Error('Branch not found');
    if (branch.mergedAt) throw new Error('Branch already merged');

    const [updated] = await db
      .update(documentBranches)
      .set({ status: 'approved', reviewedById: reviewerId })
      .where(eq(documentBranches.id, branchId))
      .returning();

    return updated;
  },

  async merge(branchId: string, userId: string) {
    const branch = await this.getById(branchId);
    if (!branch) throw new Error('Branch not found');
    if (branch.status !== 'approved') throw new Error('Branch must be approved before merging');
    if (branch.mergedAt) throw new Error('Branch already merged');

    // Update the document content
    await db
      .update(documents)
      .set({ content: branch.content, updatedAt: new Date() })
      .where(eq(documents.id, branch.documentId));

    // Create a new version
    await versionService.create({
      documentId: branch.documentId,
      content: branch.content,
      message: `Merged branch "${branch.name}"`,
      createdById: userId,
    });

    // Mark branch as merged
    const [merged] = await db
      .update(documentBranches)
      .set({ mergedAt: new Date() })
      .where(eq(documentBranches.id, branchId))
      .returning();

    return merged;
  },
};
