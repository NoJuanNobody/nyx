import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { userPipelineAccess } from '../db/schema.js';
import { deductCredits } from './credits.service.js';

// ── Service functions ─────────────────────────────────

/**
 * Check whether a user already owns access to a given pipeline.
 */
export async function hasPipelineAccess(
  userId: string,
  pipelineId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: userPipelineAccess.id })
    .from(userPipelineAccess)
    .where(
      and(
        eq(userPipelineAccess.userId, userId),
        eq(userPipelineAccess.pipelineId, pipelineId),
      ),
    )
    .limit(1);

  return !!row;
}

/**
 * Activate a pipeline for a user. If the user already owns it, return
 * the existing record without charging. Otherwise deduct credits and
 * record the access grant.
 */
export async function activatePipeline(
  userId: string,
  pipelineId: string,
  pipelineLabel: string,
  creditCost: number,
  teamId?: string,
): Promise<{ alreadyOwned: boolean; creditsPaid: number; balance: number }> {
  // Check existing ownership first
  const owned = await hasPipelineAccess(userId, pipelineId);
  if (owned) {
    // No charge — user already paid
    return { alreadyOwned: true, creditsPaid: 0, balance: -1 };
  }

  // Deduct credits only for first-time activation
  let balance = 0;
  if (creditCost > 0) {
    const result = await deductCredits(
      userId,
      creditCost,
      'pipeline_activation',
      `Activated pipeline: ${pipelineLabel}`,
    );
    balance = result.balance;
  }

  // Record the access
  await db.insert(userPipelineAccess).values({
    userId,
    pipelineId,
    teamId: teamId ?? null,
    creditsPaid: creditCost,
  });

  return { alreadyOwned: false, creditsPaid: creditCost, balance };
}

/**
 * List all pipelines a user has already purchased/activated.
 */
export async function listOwnedPipelines(
  userId: string,
): Promise<
  {
    id: string;
    pipelineId: string;
    teamId: string | null;
    activatedAt: Date;
    creditsPaid: number;
  }[]
> {
  const rows = await db
    .select({
      id: userPipelineAccess.id,
      pipelineId: userPipelineAccess.pipelineId,
      teamId: userPipelineAccess.teamId,
      activatedAt: userPipelineAccess.activatedAt,
      creditsPaid: userPipelineAccess.creditsPaid,
    })
    .from(userPipelineAccess)
    .where(eq(userPipelineAccess.userId, userId));

  return rows;
}
