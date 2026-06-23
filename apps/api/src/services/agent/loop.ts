import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../lib/config.js';
import { db } from '../../db/index.js';
import { agentSessions, agentToolCalls } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { executeTool } from './executor.js';
import { getToolDefinitions } from './tools.js';
import { checkCredits, deductCredits, getAgentCost } from '../credits.service.js';
import type { AgentContext, TokenUsage, ToolCallRecord } from './types.js';

const MODEL = 'claude-sonnet-4-6';
const MAX_ITERATIONS = 25;
const SOFT_ITERATION_WARNING = 20;
const MAX_TOOL_RESULT_CHARS = 6_000; // ~1.5K tokens — truncate large tool outputs
const TOKEN_BUDGET = 120_000; // Stop looping well before API's 200K limit
const STOP_NOTE = '\n\n[Stopped at iteration limit — output may be incomplete.]';
const TOKEN_STOP_NOTE =
  '\n\n[Stopping early — approaching token limit. Please start a new message for further exploration.]';

/**
 * Truncate a tool result string to stay within token budget.
 * Keeps the beginning and adds a truncation notice.
 */
function truncateToolResult(content: string): string {
  if (content.length <= MAX_TOOL_RESULT_CHARS) return content;
  const kept = content.slice(0, MAX_TOOL_RESULT_CHARS);
  return `${kept}\n\n... [TRUNCATED — result was ${content.length} chars. Ask for specific sections if you need more detail.]`;
}

/**
 * Compress older tool results AND old tool_use payloads in the message history
 * to reduce token usage. Keeps the last `keep` user messages at full fidelity,
 * replaces older tool_result blocks (in user messages) and tool_use input
 * payloads (in assistant messages) with a short summary.
 */
function compressOldToolResults(messages: Anthropic.MessageParam[], keep = 1): void {
  // Find the cutoff: we want to compress all but the last `keep` user messages
  let userMsgCount = 0;
  let cutoffIndex = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      userMsgCount++;
      if (userMsgCount > keep) {
        cutoffIndex = i;
        break;
      }
    }
  }

  // Replace tool_result and tool_use content in messages before the cutoff
  for (let i = 0; i <= cutoffIndex; i++) {
    const msg = messages[i];
    if (typeof msg.content === 'string') continue;
    if (!Array.isArray(msg.content)) continue;

    if (msg.role === 'user') {
      for (let j = 0; j < msg.content.length; j++) {
        const block = msg.content[j] as Anthropic.ToolResultBlockParam;
        if (block.type !== 'tool_result') continue;
        if (typeof block.content !== 'string') continue;
        if (block.content.length <= 200) continue; // already short

        // Replace with a short summary
        const preview = block.content.slice(0, 150).replace(/\n/g, ' ');
        (msg.content[j] as Anthropic.ToolResultBlockParam).content =
          `[Compressed] ${preview}... (${block.content.length} chars)`;
      }
    } else if (msg.role === 'assistant') {
      for (let j = 0; j < msg.content.length; j++) {
        const block = msg.content[j] as Anthropic.ToolUseBlockParam;
        if (block.type !== 'tool_use') continue;
        const inputJson = JSON.stringify(block.input ?? {});
        if (inputJson.length <= 200) continue;

        const preview = inputJson.slice(0, 150).replace(/\n/g, ' ');
        // Replace the input with a tiny stand-in object that explains the compression.
        (msg.content[j] as Anthropic.ToolUseBlockParam).input = {
          _compressed: `[Compressed] ${preview}... (${inputJson.length} chars)`,
        };
      }
    }
  }
}

function requireClient(): Anthropic {
  if (!config.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }
  return new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
}

export interface AgentLoopOptions {
  systemPrompt: string;
  userPrompt: string;
  toolNames?: string[];
  workflowId?: string;
  context: AgentContext;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface AgentLoopResult {
  result: string;
  toolCalls: ToolCallRecord[];
  tokenUsage: TokenUsage;
  incomplete?: boolean;
}

/**
 * Core agentic loop:
 * 1. Call messages.create() with tools
 * 2. If response has tool_use blocks -> execute -> feed tool_result back
 * 3. Repeat until end_turn or max iterations
 */
export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const { systemPrompt, userPrompt, toolNames, workflowId, context, history } = options;

  // ── Credit gate: verify the user can afford this run ──
  const creditCost = getAgentCost(workflowId);
  const creditCheck = await checkCredits(context.userId, creditCost);
  if (!creditCheck.allowed) {
    await db
      .update(agentSessions)
      .set({ status: 'failed', result: 'Insufficient credits' })
      .where(eq(agentSessions.id, context.sessionId));
    context.onEvent?.({ type: 'status', status: 'failed' });
    context.onEvent?.({
      type: 'credits_depleted',
      balance: creditCheck.balance,
      required: creditCheck.required,
    });
    throw {
      statusCode: 402,
      message: `Insufficient credits. Balance: ${creditCheck.balance}, required: ${creditCheck.required}`,
    };
  }

  const client = requireClient();
  const tools = getToolDefinitions(toolNames);

  const messages: Anthropic.MessageParam[] = [];

  // Prepend conversation history for multi-turn context
  if (history?.length) {
    const recent = history.slice(-8); // Cap at 4 turns to control token budget
    for (const msg of recent) {
      messages.push({ role: msg.role, content: msg.content });
    }
  }

  messages.push({ role: 'user', content: userPrompt });

  const allToolCalls: ToolCallRecord[] = [];
  const tokenUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  let sequence = 0;
  // Preserve the most recent non-empty text the model produced — used as
  // the fallback `result` when we hit a terminal early-exit branch.
  let lastTextOutput = '';
  let softWarningEmitted = false;

  // Emit initial status
  context.onEvent?.({ type: 'status', status: 'running' });

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    // Check for cancellation
    if (context.cancelled?.()) {
      await db
        .update(agentSessions)
        .set({ status: 'cancelled' })
        .where(eq(agentSessions.id, context.sessionId));
      context.onEvent?.({ type: 'status', status: 'cancelled' });
      break;
    }

    // Soft-warning: tell the user we're approaching the ceiling so they can
    // see it on the streaming UI before we actually terminate.
    if (iteration === SOFT_ITERATION_WARNING && !softWarningEmitted) {
      softWarningEmitted = true;
      context.onEvent?.({
        type: 'text',
        text: '\n\n[Warning: approaching iteration ceiling — the agent may wrap up soon.]',
      });
    }

    // Compress old tool results / tool_use payloads every iteration after the first
    if (iteration >= 1) {
      compressOldToolResults(messages);
    }

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      tools: tools.map((t, i) =>
        i === tools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t,
      ),
      messages,
    });

    // Track token usage (regular + cached read)
    tokenUsage.inputTokens += response.usage.input_tokens;
    tokenUsage.outputTokens += response.usage.output_tokens;
    const cachedRead =
      (response.usage as { cache_read_input_tokens?: number | null }).cache_read_input_tokens ?? 0;
    if (cachedRead) {
      tokenUsage.cachedInputTokens = (tokenUsage.cachedInputTokens ?? 0) + cachedRead;
    }

    // Process content blocks
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    let textOutput = '';

    for (const block of response.content) {
      if (block.type === 'text') {
        textOutput += block.text;
        context.onEvent?.({ type: 'text', text: block.text });
      } else if (block.type === 'tool_use') {
        sequence++;
        const toolInput = block.input as Record<string, unknown>;

        context.onEvent?.({
          type: 'tool_call',
          toolName: block.name,
          input: toolInput,
          sequence,
        });

        // Execute the tool
        const start = Date.now();
        let output: unknown;
        let error: string | undefined;

        try {
          output = await executeTool(block.name, toolInput, context);
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
          output = { error };
          console.error(
            `[agent] Tool "${block.name}" failed (session=${context.sessionId}):`,
            error,
          );
        }

        const durationMs = Date.now() - start;

        const record: ToolCallRecord = {
          toolName: block.name,
          input: toolInput,
          output,
          durationMs,
          error,
          sequence,
        };
        allToolCalls.push(record);

        // Persist tool call to DB
        await db.insert(agentToolCalls).values({
          sessionId: context.sessionId,
          toolName: block.name,
          input: toolInput,
          output: output as Record<string, unknown>,
          durationMs,
          error: error ?? null,
          sequence,
        });

        context.onEvent?.({
          type: 'tool_result',
          toolName: block.name,
          output,
          sequence,
          durationMs,
          error,
        });

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: truncateToolResult(JSON.stringify(output)),
          is_error: !!error,
        });
      }
    }

    // Track the latest non-empty text so the early-exit branches can
    // preserve it instead of overwriting with a generic message.
    if (textOutput.trim().length > 0) {
      lastTextOutput = textOutput;
    }

    // If there were tool uses, feed results back and continue
    if (toolResults.length > 0) {
      // ── Token-budget early-exit (its own terminal block, NOT a fallthrough) ──
      if (tokenUsage.inputTokens + tokenUsage.outputTokens > TOKEN_BUDGET) {
        return await terminateIncomplete({
          context,
          workflowId,
          creditCost,
          allToolCalls,
          tokenUsage,
          lastTextOutput,
          stopNote: TOKEN_STOP_NOTE,
        });
      }
      messages.push({
        role: 'assistant',
        content: response.content as Anthropic.ContentBlockParam[],
      });
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    // No tool uses — we're done
    const finalResult = textOutput || 'Agent completed without text output.';

    // ── Deduct credits after successful completion ──
    const workflowLabel = workflowId ?? 'custom';
    const deductResult = await deductCredits(
      context.userId,
      creditCost,
      `agent_${workflowLabel}`,
      `Agent workflow "${workflowLabel}" (session ${context.sessionId})`,
    );

    // Update session
    await db
      .update(agentSessions)
      .set({
        status: 'completed',
        result: finalResult,
        toolCallCount: allToolCalls.length,
        tokenUsage,
      })
      .where(eq(agentSessions.id, context.sessionId));

    context.onEvent?.({
      type: 'done',
      result: finalResult,
      toolCallCount: allToolCalls.length,
      tokenUsage,
      creditsUsed: creditCost,
      creditBalance: deductResult.balance,
    });

    return { result: finalResult, toolCalls: allToolCalls, tokenUsage };
  }

  // Max iterations reached — terminal block (preserve text, conditional credit charge)
  return await terminateIncomplete({
    context,
    workflowId,
    creditCost,
    allToolCalls,
    tokenUsage,
    lastTextOutput,
    stopNote: STOP_NOTE,
  });
}

/**
 * Shared terminal handler for early-exit branches (max iterations, token budget).
 *
 * - Preserves the last non-empty text the model produced (with a trailing stop note)
 *   instead of overwriting with a generic literal.
 * - Marks the session `status` as `'failed'` (reused enum value) to distinguish from
 *   a clean completion.
 * - Only deducts credits when the model actually produced usable text — runs that
 *   die mid-research with no output do NOT bill the user.
 * - Emits a `done` event with `incomplete: true` so the UI can render a distinct state.
 */
async function terminateIncomplete(args: {
  context: AgentContext;
  workflowId?: string;
  creditCost: number;
  allToolCalls: ToolCallRecord[];
  tokenUsage: TokenUsage;
  lastTextOutput: string;
  stopNote: string;
}): Promise<AgentLoopResult> {
  const { context, workflowId, creditCost, allToolCalls, tokenUsage, lastTextOutput, stopNote } =
    args;

  const hasUsableText = lastTextOutput.trim().length > 0;
  const result = hasUsableText ? `${lastTextOutput}${stopNote}` : stopNote.trim();

  let creditBalance: number | undefined;
  if (hasUsableText) {
    const workflowLabel = workflowId ?? 'custom';
    const deductResult = await deductCredits(
      context.userId,
      creditCost,
      `agent_${workflowLabel}`,
      `Agent workflow "${workflowLabel}" incomplete (session ${context.sessionId})`,
    );
    creditBalance = deductResult.balance;
  }

  await db
    .update(agentSessions)
    .set({
      // Reuse the existing 'failed' enum value to avoid an additional Drizzle migration.
      status: 'failed',
      result,
      toolCallCount: allToolCalls.length,
      tokenUsage,
    })
    .where(eq(agentSessions.id, context.sessionId));

  context.onEvent?.({
    type: 'done',
    result,
    toolCallCount: allToolCalls.length,
    tokenUsage,
    creditsUsed: hasUsableText ? creditCost : 0,
    creditBalance,
    incomplete: true,
  });

  return { result, toolCalls: allToolCalls, tokenUsage, incomplete: true };
}
