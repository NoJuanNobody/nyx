import { eq, and, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { approvals } from '../db/schema.js';

/** Default approval expiry: 7 days from now. */
const DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

export interface CreateApprovalParams {
  action: string;
  resourceId: string;
  requestedById: string;
  teamId: string;
  metadata?: Record<string, unknown>;
  expiresInMs?: number;
}

export const approvalService = {
  /**
   * Create a pending approval request.
   */
  async create(params: CreateApprovalParams) {
    const expiresAt = new Date(Date.now() + (params.expiresInMs ?? DEFAULT_EXPIRY_MS));

    const [approval] = await db
      .insert(approvals)
      .values({
        action: params.action,
        resourceId: params.resourceId,
        requestedById: params.requestedById,
        teamId: params.teamId,
        metadata: params.metadata ?? {},
        expiresAt,
      })
      .returning();

    return approval;
  },

  /**
   * Approve a pending approval request.
   */
  async approve(approvalId: string, reviewerId: string, reason?: string) {
    const [existing] = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approvalId))
      .limit(1);

    if (!existing) return null;
    if (existing.status !== 'pending') return existing;

    if (existing.expiresAt < new Date()) {
      const [expired] = await db
        .update(approvals)
        .set({ status: 'expired' })
        .where(eq(approvals.id, approvalId))
        .returning();
      return expired;
    }

    const [updated] = await db
      .update(approvals)
      .set({
        status: 'approved',
        reviewedById: reviewerId,
        reviewedAt: new Date(),
        reason: reason ?? null,
      })
      .where(eq(approvals.id, approvalId))
      .returning();

    return updated;
  },

  /**
   * Reject a pending approval request.
   */
  async reject(approvalId: string, reviewerId: string, reason?: string) {
    const [existing] = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approvalId))
      .limit(1);

    if (!existing) return null;
    if (existing.status !== 'pending') return existing;

    const [updated] = await db
      .update(approvals)
      .set({
        status: 'rejected',
        reviewedById: reviewerId,
        reviewedAt: new Date(),
        reason: reason ?? null,
      })
      .where(eq(approvals.id, approvalId))
      .returning();

    return updated;
  },

  /**
   * Check whether a specific action+resource has a pending or approved approval.
   * Returns the most recent matching approval, or null.
   */
  async check(action: string, resourceId: string, teamId: string) {
    const [approval] = await db
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.action, action),
          eq(approvals.resourceId, resourceId),
          eq(approvals.teamId, teamId),
        ),
      )
      .orderBy(desc(approvals.createdAt))
      .limit(1);

    return approval ?? null;
  },

  /**
   * List approvals for a team, optionally filtered by status.
   */
  async listByTeam(teamId: string, status?: string) {
    let query = db
      .select()
      .from(approvals)
      .where(eq(approvals.teamId, teamId))
      .orderBy(desc(approvals.createdAt))
      .$dynamic();

    if (status) {
      query = db
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.teamId, teamId),
            eq(approvals.status, status as 'pending' | 'approved' | 'rejected' | 'expired'),
          ),
        )
        .orderBy(desc(approvals.createdAt))
        .$dynamic();
    }

    return query;
  },

  /**
   * Get a single approval by ID.
   */
  async getById(approvalId: string) {
    const [approval] = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approvalId))
      .limit(1);

    return approval ?? null;
  },
};
