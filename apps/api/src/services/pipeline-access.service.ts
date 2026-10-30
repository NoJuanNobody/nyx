import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { userPipelineAccess } from '../db/schema.js';

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
 * Activate a pipeline for a user. Activation is free (AI-58: no re-pay logic);
 * it only records the access grant, idempotently.
 */
export async function activatePipeline(
  userId: string,
  pipelineId: string,
  _pipelineLabel: string,
  teamId?: string,
): Promise<{ alreadyOwned: boolean; creditsPaid: number }> {
  if (await hasPipelineAccess(userId, pipelineId)) {
    return { alreadyOwned: true, creditsPaid: 0 };
  }

  await db
    .insert(userPipelineAccess)
    .values({ userId, pipelineId, teamId: teamId ?? null, creditsPaid: 0 })
    .onConflictDoNothing();

  return { alreadyOwned: false, creditsPaid: 0 };
}

/**
 * List all pipelines a user has already activated.
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
