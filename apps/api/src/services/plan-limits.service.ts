import { eq, and, ne } from 'drizzle-orm';
import { db } from '../db/index.js';
import { subscriptions, documents, teamMembers } from '../db/schema.js';
import { PLAN_LIMITS, type PlanName } from '../config/plans.js';

export interface LimitCheckResult {
  allowed: boolean;
  current: number;
  limit: number;
  plan: PlanName;
}

export interface PlanUsage {
  plan: PlanName;
  documents: { current: number; limit: number };
  teamMembers: { current: number; limit: number };
  ai: boolean;
  voice: boolean;
}

async function getTeamPlan(teamId: string): Promise<PlanName> {
  const [sub] = await db
    .select({ plan: subscriptions.plan, status: subscriptions.status })
    .from(subscriptions)
    .where(eq(subscriptions.teamId, teamId))
    .limit(1);

  if (!sub || (sub.status !== 'active' && sub.status !== 'trialing')) {
    return 'free';
  }

  return (sub.plan as PlanName) ?? 'free';
}

async function getDocumentCount(teamId: string): Promise<number> {
  const rows = await db
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(
        eq(documents.teamId, teamId),
        ne(documents.status, 'archived'),
      ),
    );
  return rows.length;
}

async function getMemberCount(teamId: string): Promise<number> {
  const rows = await db
    .select({ id: teamMembers.id })
    .from(teamMembers)
    .where(eq(teamMembers.teamId, teamId));
  return rows.length;
}

export const planLimitsService = {
  async checkDocumentLimit(teamId: string): Promise<LimitCheckResult> {
    const plan = await getTeamPlan(teamId);
    const limits = PLAN_LIMITS[plan];
    const current = await getDocumentCount(teamId);
    const limit = limits.documents;

    return {
      allowed: limit === -1 || current < limit,
      current,
      limit,
      plan,
    };
  },

  async checkMemberLimit(teamId: string): Promise<LimitCheckResult> {
    const plan = await getTeamPlan(teamId);
    const limits = PLAN_LIMITS[plan];
    const current = await getMemberCount(teamId);
    const limit = limits.teamMembers;

    return {
      allowed: limit === -1 || current < limit,
      current,
      limit,
      plan,
    };
  },

  async getPlanUsage(teamId: string): Promise<PlanUsage> {
    const plan = await getTeamPlan(teamId);
    const limits = PLAN_LIMITS[plan];
    const [docCount, memberCount] = await Promise.all([
      getDocumentCount(teamId),
      getMemberCount(teamId),
    ]);

    return {
      plan,
      documents: { current: docCount, limit: limits.documents },
      teamMembers: { current: memberCount, limit: limits.teamMembers },
      ai: limits.ai,
      voice: limits.voice,
    };
  },
};
