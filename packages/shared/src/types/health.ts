import { z } from 'zod';

export const CheckResultStatus = z.enum(['ok', 'unavailable']);
export type CheckResultStatus = z.infer<typeof CheckResultStatus>;

export const CheckResultSchema = z.object({
  status: CheckResultStatus,
  latencyMs: z.number().nullable(),
  error: z.string().optional(),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

export const HealthStatus = z.enum(['ok', 'degraded', 'unavailable']);
export type HealthStatus = z.infer<typeof HealthStatus>;

export const LivenessResponseSchema = z.object({
  status: z.literal('ok'),
});
export type LivenessResponse = z.infer<typeof LivenessResponseSchema>;

export const ReadinessResponseSchema = z.object({
  status: HealthStatus,
  checks: z.record(z.string(), CheckResultSchema),
  version: z.string(),
  uptime: z.number(),
});
export type ReadinessResponse = z.infer<typeof ReadinessResponseSchema>;

export const DependencyName = z.enum(['database', 'clerk', 'github']);
export type DependencyName = z.infer<typeof DependencyName>;
