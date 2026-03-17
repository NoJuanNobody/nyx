import { z } from 'zod';

export const DocumentStatus = z.enum(['draft', 'published', 'archived']);
export type DocumentStatus = z.infer<typeof DocumentStatus>;

// Widened from z.enum to z.string() to support multiple lifecycle pipelines
export const DocumentStage = z.string();
export type DocumentStage = z.infer<typeof DocumentStage>;

export const DocumentSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  content: z.string(),
  path: z.string(),
  status: DocumentStatus,
  stage: z.string().nullable().optional(),
  lifecycleId: z.string().uuid().nullable().optional(),
  teamId: z.string().uuid(),
  createdById: z.string().uuid(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Document = z.infer<typeof DocumentSchema>;

export const DocumentVersionSchema = z.object({
  id: z.string().uuid(),
  documentId: z.string().uuid(),
  version: z.number().int().positive(),
  content: z.string(),
  message: z.string().nullable(),
  createdById: z.string().uuid(),
  createdAt: z.string().datetime(),
});

export type DocumentVersion = z.infer<typeof DocumentVersionSchema>;

export const DocumentBranchSchema = z.object({
  id: z.string().uuid(),
  documentId: z.string().uuid(),
  name: z.string(),
  baseVersionId: z.string().uuid(),
  content: z.string(),
  createdById: z.string().uuid(),
  status: z.string(),
  reviewedById: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  mergedAt: z.string().datetime().nullable(),
});

export type DocumentBranch = z.infer<typeof DocumentBranchSchema>;

export const DocumentTemplateSchema = z.object({
  id: z.string().uuid(),
  stage: z.string(),
  name: z.string(),
  description: z.string(),
  content: z.string(),
  sortOrder: z.number().int(),
  teamId: z.string().uuid().nullable().optional(),
  createdById: z.string().uuid().nullable().optional(),
  lifecycleId: z.string().uuid().nullable().optional(),
  createdAt: z.string().datetime(),
});

export type DocumentTemplate = z.infer<typeof DocumentTemplateSchema>;
