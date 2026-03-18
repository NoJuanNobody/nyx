import { eq, and, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { stripeCustomers, documents, users, teamMembers } from '../db/schema.js';

// ── Plan definitions ────────────────────────────────────

export type PlanName = 'free' | 'pro' | 'team' | 'enterprise';

export type LimitAction = 'create_document' | 'use_ai' | 'use_voice';

export interface PlanLimits {
  maxDocuments: number; // -1 = unlimited
  aiEnabled: boolean;
  voiceEnabled: boolean;
  maxPipelines: number; // -1 = unlimited
}

export interface CheckLimitResult {
  allowed: boolean;
  limit: number;
  current: number;
  plan: string;
}

export interface UsageSummary {
  plan: string;
  documents: { current: number; limit: number };
  ai: { enabled: boolean };
  voice: { enabled: boolean };
  pipelines: { limit: number };
}

const PLAN_DEFINITIONS: Record<PlanName, PlanLimits> = {
  free: {
    maxDocuments: 5,
    aiEnabled: false,
    voiceEnabled: false,
    maxPipelines: 1,
  },
  pro: {
    maxDocuments: -1,
    aiEnabled: true,
    voiceEnabled: false,
    maxPipelines: -1,
  },
  team: {
    maxDocuments: -1,
    aiEnabled: true,
    voiceEnabled: true,
    maxPipelines: -1,
  },
  enterprise: {
    maxDocuments: -1,
    aiEnabled: true,
    voiceEnabled: true,
    maxPipelines: -1,
  },
};

// ── Public API ──────────────────────────────────────────

/**
 * Returns the plan limits definition for a given plan name.
 */
export function getPlanLimits(plan: string): PlanLimits {
  const key = plan as PlanName;
  return PLAN_DEFINITIONS[key] ?? PLAN_DEFINITIONS.free;
}

/**
 * Reads the user's plan from the stripe_customers table.
 * Defaults to 'free' if no record exists.
 */
export async function getUserPlan(userId: string): Promise<string> {
  const [customer] = await db
    .select({ plan: stripeCustomers.plan })
    .from(stripeCustomers)
    .where(eq(stripeCustomers.userId, userId))
    .limit(1);

  return customer?.plan ?? 'free';
}

/**
 * Counts the number of documents created by a user across all their teams.
 */
async function getDocumentCount(userId: string): Promise<number> {
  const result = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(documents)
    .where(eq(documents.createdById, userId));

  return result[0]?.count ?? 0;
}

/**
 * Checks whether a user is allowed to perform the given action
 * based on their current plan and usage.
 */
export async function checkLimit(
  userId: string,
  action: LimitAction,
): Promise<CheckLimitResult> {
  const plan = await getUserPlan(userId);
  const limits = getPlanLimits(plan);

  switch (action) {
    case 'create_document': {
      if (limits.maxDocuments === -1) {
        return { allowed: true, limit: -1, current: 0, plan };
      }
      const current = await getDocumentCount(userId);
      return {
        allowed: current < limits.maxDocuments,
        limit: limits.maxDocuments,
        current,
        plan,
      };
    }

    case 'use_ai': {
      return {
        allowed: limits.aiEnabled,
        limit: limits.aiEnabled ? 1 : 0,
        current: 0,
        plan,
      };
    }

    case 'use_voice': {
      return {
        allowed: limits.voiceEnabled,
        limit: limits.voiceEnabled ? 1 : 0,
        current: 0,
        plan,
      };
    }

    default: {
      return { allowed: false, limit: 0, current: 0, plan };
    }
  }
}

/**
 * Returns a full usage summary for the user including plan info
 * and current consumption of all tracked resources.
 */
export async function getUsageSummary(userId: string): Promise<UsageSummary> {
  const plan = await getUserPlan(userId);
  const limits = getPlanLimits(plan);
  const documentCount = await getDocumentCount(userId);

  return {
    plan,
    documents: {
      current: documentCount,
      limit: limits.maxDocuments,
    },
    ai: {
      enabled: limits.aiEnabled,
    },
    voice: {
      enabled: limits.voiceEnabled,
    },
    pipelines: {
      limit: limits.maxPipelines,
    },
  };
}
