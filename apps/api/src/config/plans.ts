/**
 * Plan limits configuration.
 * -1 means unlimited.
 */
export const PLAN_LIMITS = {
  free: {
    documents: 5,
    teamMembers: 1,
    ai: false,
    voice: false,
  },
  pro: {
    documents: -1,
    teamMembers: 5,
    ai: true,
    voice: false,
  },
  team: {
    documents: -1,
    teamMembers: -1,
    ai: true,
    voice: true,
  },
  enterprise: {
    documents: -1,
    teamMembers: -1,
    ai: true,
    voice: true,
  },
} as const;

export type PlanName = keyof typeof PLAN_LIMITS;
export type PlanLimits = (typeof PLAN_LIMITS)[PlanName];
