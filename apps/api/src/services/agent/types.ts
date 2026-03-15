import type Anthropic from '@anthropic-ai/sdk';

// ── Session status ──────────────────────────────────────
export type AgentSessionStatus = 'running' | 'completed' | 'failed' | 'cancelled';

// ── Token usage tracking ────────────────────────────────
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

// ── Tool call record ────────────────────────────────────
export interface ToolCallRecord {
  toolName: string;
  input: Record<string, unknown>;
  output: unknown;
  durationMs: number;
  error?: string;
  sequence: number;
}

// ── SSE event types ─────────────────────────────────────
export type AgentEvent =
  | { type: 'status'; status: AgentSessionStatus }
  | { type: 'tool_call'; toolName: string; input: Record<string, unknown>; sequence: number }
  | { type: 'tool_result'; toolName: string; output: unknown; sequence: number; durationMs: number; error?: string }
  | { type: 'text'; text: string }
  | { type: 'done'; result: string; toolCallCount: number; tokenUsage: TokenUsage };

// ── Agent context (passed through the loop) ─────────────
export interface AgentContext {
  userId: string;
  userRole: 'owner' | 'admin' | 'developer' | 'editor' | 'viewer';
  teamId: string;
  documentId?: string;
  sessionId: string;
  onEvent?: (event: AgentEvent) => void;
  cancelled?: () => boolean;
}

// ── Workflow definition ─────────────────────────────────
export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  defaultPrompt?: string;
  postSessionSuggestions?: string[];
}

// ── Tool definition (Anthropic SDK shape) ───────────────
export type ToolDefinition = Anthropic.Tool;
