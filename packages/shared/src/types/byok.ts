import { z } from 'zod';

export const AiProvider = z.enum(['anthropic', 'openai']);
export type AiProvider = z.infer<typeof AiProvider>;

export const KeySource = z.enum(['syncdocs', 'byok']);
export type KeySource = z.infer<typeof KeySource>;

export const TeamAiKeyStatusSchema = z.object({
  provider: AiProvider,
  keySuffix: z.string(),
  isActive: z.boolean(),
  createdAt: z.string(),
  rotatedAt: z.string().nullable(),
});

export type TeamAiKeyStatus = z.infer<typeof TeamAiKeyStatusSchema>;

export const AiUsageSummarySchema = z.object({
  totalInputTokens: z.number(),
  totalOutputTokens: z.number(),
  keySource: KeySource.nullable(),
  byOperation: z.array(z.object({
    operation: z.string(),
    inputTokens: z.number(),
    outputTokens: z.number(),
  })),
});

export type AiUsageSummary = z.infer<typeof AiUsageSummarySchema>;

export const AddAiKeyRequestSchema = z.object({
  provider: AiProvider,
  apiKey: z.string().min(1),
});

export type AddAiKeyRequest = z.infer<typeof AddAiKeyRequestSchema>;

export const RotateAiKeyRequestSchema = z.object({
  apiKey: z.string().min(1),
});

export type RotateAiKeyRequest = z.infer<typeof RotateAiKeyRequestSchema>;
