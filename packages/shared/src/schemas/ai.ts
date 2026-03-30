import { z } from 'zod';

export const analyzeSpecBody = z.object({
  content: z.string().min(1),
  stage: z.string().optional(),
});

export const detectDriftBody = z.object({
  specContent: z.string().min(1),
  codeContent: z.string().min(1),
});

export const generateDocumentBody = z.object({
  prompt: z.string().min(1),
  context: z.string().optional(),
});

export const editDocumentBody = z.object({
  content: z.string().min(1),
  instruction: z.string().min(1),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string(),
  })).optional(),
});

export const generateTicketBody = z.object({
  diff: z.string().min(1),
  context: z.string().optional(),
});

export const jsxPreviewBody = z.object({
  prompt: z.string().min(1),
  context: z.string().optional(),
  allStates: z.boolean().optional(),
});

export const jsxPreviewRefineBody = z.object({
  currentJSX: z.string().min(1),
  prompt: z.string().min(1),
});

export const meetingQualityBody = z.object({
  content: z.string().min(1),
});

export const meetingApplySuggestionsBody = z.object({
  content: z.string().min(1),
  suggestions: z.array(z.string()).min(1),
});

export const generateNewsArticleBody = z.object({
  topic: z.string().min(1),
  context: z.string().optional(),
});

export const seedFromStageBody = z.object({
  documentId: z.string().min(1),
  fromStage: z.string().min(1),
  toStage: z.string().min(1),
  content: z.string().min(1),
});

export const missingSectionsBody = z.object({
  content: z.string().min(1),
  stage: z.string().optional(),
});

export const notificationReplyBody = z.object({
  notificationId: z.string().min(1),
  message: z.string().min(1),
  documentId: z.string().min(1),
  content: z.string().optional(),
});

export const decisionWeightBody = z.object({
  content: z.string().min(1),
  stage: z.string().optional(),
});

export const seedNextStageBody = z.object({
  content: z.string().min(1),
  fromStage: z.string().min(1),
  toStage: z.string().min(1),
});

export const generateAllBody = z.object({
  teamId: z.string().min(1),
});
