import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../lib/config.js';
import { db } from '../../db/index.js';
import { agentSessions, agentToolCalls } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { executeTool } from './executor.js';
import { getToolDefinitions } from './tools.js';
import type { AgentContext, TokenUsage, ToolCallRecord } from './types.js';

const MODEL = 'claude-sonnet-4-20250514';
const MAX_ITERATIONS = 15;

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
  context: AgentContext;
}

export interface AgentLoopResult {
  result: string;
  toolCalls: ToolCallRecord[];
  tokenUsage: TokenUsage;
}

/**
 * Core agentic loop:
 * 1. Call messages.create() with tools
 * 2. If response has tool_use blocks -> execute -> feed tool_result back
 * 3. Repeat until end_turn or max iterations
 */
export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const { systemPrompt, userPrompt, toolNames, context } = options;
  const client = requireClient();
  const tools = getToolDefinitions(toolNames);

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: userPrompt },
  ];

  const allToolCalls: ToolCallRecord[] = [];
  const tokenUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let sequence = 0;

  // Emit initial status
  context.onEvent?.({ type: 'status', status: 'running' });

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    // Check for cancellation
    if (context.cancelled?.()) {
      await db.update(agentSessions).set({ status: 'cancelled' }).where(eq(agentSessions.id, context.sessionId));
      context.onEvent?.({ type: 'status', status: 'cancelled' });
      break;
    }

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      tools,
      messages,
    });

    // Track token usage
    tokenUsage.inputTokens += response.usage.input_tokens;
    tokenUsage.outputTokens += response.usage.output_tokens;

    // Process content blocks
    const toolUseBlocks: Anthropic.ContentBlockParam[] = [];
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

        toolUseBlocks.push(block);

        // Execute the tool
        const start = Date.now();
        let output: unknown;
        let error: string | undefined;

        try {
          output = await executeTool(block.name, toolInput, context);
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
          output = { error };
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
          content: JSON.stringify(output),
          is_error: !!error,
        });
      }
    }

    // If there were tool uses, feed results back and continue
    if (toolResults.length > 0) {
      messages.push({ role: 'assistant', content: response.content as Anthropic.ContentBlockParam[] });
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    // No tool uses — we're done
    const finalResult = textOutput || 'Agent completed without text output.';

    // Update session
    await db.update(agentSessions).set({
      status: 'completed',
      result: finalResult,
      toolCallCount: allToolCalls.length,
      tokenUsage,
    }).where(eq(agentSessions.id, context.sessionId));

    context.onEvent?.({
      type: 'done',
      result: finalResult,
      toolCallCount: allToolCalls.length,
      tokenUsage,
    });

    return { result: finalResult, toolCalls: allToolCalls, tokenUsage };
  }

  // Max iterations reached
  const maxResult = 'Agent reached maximum iteration limit.';
  await db.update(agentSessions).set({
    status: 'completed',
    result: maxResult,
    toolCallCount: allToolCalls.length,
    tokenUsage,
  }).where(eq(agentSessions.id, context.sessionId));

  context.onEvent?.({
    type: 'done',
    result: maxResult,
    toolCallCount: allToolCalls.length,
    tokenUsage,
  });

  return { result: maxResult, toolCalls: allToolCalls, tokenUsage };
}
