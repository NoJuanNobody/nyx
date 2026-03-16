import { z } from 'zod';

export const TranscriptSegmentSchema = z.object({
  speaker: z.string(),
  text: z.string(),
  startMs: z.number(),
  endMs: z.number(),
  confidence: z.number().optional(),
});
export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;

export const DecisionSchema = z.object({
  id: z.string(),
  text: z.string(),
  madeBy: z.string().optional(),
  context: z.string().optional(),
  timestampMs: z.number().optional(),
});
export type Decision = z.infer<typeof DecisionSchema>;

export const ActionItemSchema = z.object({
  id: z.string(),
  text: z.string(),
  assignee: z.string().optional(),
  deadline: z.string().optional(),
  priority: z.enum(['high', 'medium', 'low']).optional(),
  status: z.enum(['pending', 'in_progress', 'done']),
});
export type ActionItem = z.infer<typeof ActionItemSchema>;

export const CodeReferenceSchema = z.object({
  id: z.string(),
  filePath: z.string().optional(),
  symbol: z.string().optional(),
  repository: z.string().optional(),
  context: z.string().optional(),
  timestampMs: z.number().optional(),
});
export type CodeReference = z.infer<typeof CodeReferenceSchema>;

export const OpenQuestionSchema = z.object({
  id: z.string(),
  text: z.string(),
  raisedBy: z.string().optional(),
  context: z.string().optional(),
  resolved: z.boolean(),
  timestampMs: z.number().optional(),
});
export type OpenQuestion = z.infer<typeof OpenQuestionSchema>;

export const MeetingIntelligenceSchema = z.object({
  sessionId: z.string(),
  transcript: z.array(TranscriptSegmentSchema),
  decisions: z.array(DecisionSchema),
  actionItems: z.array(ActionItemSchema),
  codeReferences: z.array(CodeReferenceSchema),
  openQuestions: z.array(OpenQuestionSchema),
  summary: z.string(),
  duration: z.number(),
  participants: z.array(z.string()),
  createdAt: z.string(),
});
export type MeetingIntelligence = z.infer<typeof MeetingIntelligenceSchema>;

/**
 * Parsed intelligence — the subset of MeetingIntelligence that comes from
 * the semantic parser (excludes sessionId, raw transcript, and metadata).
 */
export const ParsedIntelligenceSchema = z.object({
  decisions: z.array(DecisionSchema),
  actionItems: z.array(ActionItemSchema),
  codeReferences: z.array(CodeReferenceSchema),
  openQuestions: z.array(OpenQuestionSchema),
  summary: z.string(),
  participants: z.array(z.string()),
});
export type ParsedIntelligence = z.infer<typeof ParsedIntelligenceSchema>;
