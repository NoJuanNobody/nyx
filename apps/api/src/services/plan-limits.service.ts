import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { stripeCustomers, documents, teamMembers } from '../db/schema.js';

// ── Plan definitions ────────────────────────────────────

export type PlanName = 'free' | 'starter' | 'pro' | 'team' | 'enterprise';

export type LimitAction =
  | 'create_document'
  | 'use_ai'
  | 'use_voice'
  | 'create_member'
  | 'connect_repo';

export interface PlanLimits {
  maxDocuments: number;      // -1 = unlimited
  maxUsers: number;          // -1 = unlimited
  maxProjects: number;       // -1 = unlimited
  maxRepos: number;          // -1 = unlimited
  aiEnabled: boolean;
  voiceEnabled: boolean;
  maxPipelines: number;      // -1 = unlimited
  webhookAutomation: boolean;
  byokRequired: boolean;
  monthlyAiCredits: number;  // -1 = unlimited (consumed from credit balance)
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
  webhookAutomation: boolean;
  byokRequired: boolean;
}

const PLAN_DEFINITIONS: Record<PlanName, PlanLimits> = {
  free: {
    maxDocuments: 5,
    maxUsers: 1,
    maxProjects: 1,
    maxRepos: 1,
    aiEnabled: true,
    voiceEnabled: false,
    maxPipelines: 1,
    webhookAutomation: false,
    byokRequired: false,
    monthlyAiCredits: 10,
  },
  starter: {
    maxDocuments: -1,
    maxUsers: 1,
    maxProjects: 3,
    maxRepos: 2,
    aiEnabled: true,
    voiceEnabled: false,
    maxPipelines: -1,
    webhookAutomation: true,
    byokRequired: false,
    monthlyAiCredits: 100,
  },
  pro: {
    maxDocuments: -1,
    maxUsers: 5,
    maxProjects: 10,
    maxRepos: -1,
    aiEnabled: true,
    voiceEnabled: false,
    maxPipelines: -1,
    webhookAutomation: true,
    byokRequired: false,
    monthlyAiCredits: 500,
  },
  team: {
    maxDocuments: -1,
    maxUsers: 25,
    maxProjects: -1,
    maxRepos: -1,
    aiEnabled: true,
    voiceEnabled: true,
    maxPipelines: -1,
    webhookAutomation: true,
    byokRequired: true,
    monthlyAiCredits: -1,
  },
  enterprise: {
    maxDocuments: -1,
    maxUsers: -1,
    maxProjects: -1,
    maxRepos: -1,
    aiEnabled: true,
    voiceEnabled: true,
    maxPipelines: -1,
    webhookAutomation: true,
    byokRequired: true,
    monthlyAiCredits: -1,
  },
};

// ── Public API ──────────────────────────────────────────

export function getPlanLimits(plan: string): PlanLimits {
  const key = plan as PlanName;
  return PLAN_DEFINITIONS[key] ?? PLAN_DEFINITIONS.free;
}

export async function getUserPlan(userId: string): Promise<string> {
  const [customer] = await db
    .select({ plan: stripeCustomers.plan })
    .from(stripeCustomers)
    .where(eq(stripeCustomers.userId, userId))
    .limit(1);

  return customer?.plan ?? 'free';
}

async function getDocumentCount(userId: string): Promise<number> {
  const result = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(documents)
    .where(eq(documents.createdById, userId));

  return result[0]?.count ?? 0;
}

async function getMemberCount(teamId: string): Promise<number> {
  const result = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(teamMembers)
    .where(eq(teamMembers.teamId, teamId));

  return result[0]?.count ?? 0;
}

export async function checkLimit(
  userId: string,
  action: LimitAction,
  context?: { teamId?: string },
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

    case 'create_member': {
      if (limits.maxUsers === -1) {
        return { allowed: true, limit: -1, current: 0, plan };
      }
      const teamId = context?.teamId;
      const current = teamId ? await getMemberCount(teamId) : 0;
      return {
        allowed: current < limits.maxUsers,
        limit: limits.maxUsers,
        current,
        plan,
      };
    }

    case 'connect_repo': {
      if (limits.maxRepos === -1) {
        return { allowed: true, limit: -1, current: 0, plan };
      }
      return { allowed: false, limit: limits.maxRepos, current: 0, plan };
    }

    default: {
      return { allowed: false, limit: 0, current: 0, plan };
    }
  }
}

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
    webhookAutomation: limits.webhookAutomation,
    byokRequired: limits.byokRequired,
  };
}
