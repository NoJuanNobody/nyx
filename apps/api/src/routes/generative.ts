/**
 * POST /api/generative/run — AG-UI compatible streaming endpoint for Hashbrown.
 *
 * Receives a RunAgentInput from the Hashbrown React frontend and streams back
 * AG-UI SSE events. Components (DriftResolutionCard, TicketStagingWidget,
 * LivingSchemaPreview) are rendered by the model via tool calls, whose partial
 * JSON args are forwarded as TOOL_CALL_ARGS events so Hashbrown can stream-render
 * props into the registered React components.
 *
 * We implement our own AG-UI adapter (rather than @hashbrownai/anthropic) to
 * avoid a peer-dep conflict: @hashbrownai/anthropic@0.7.0 requires
 * @anthropic-ai/sdk@0.122.0 while the rest of the codebase pins 0.39.0.
 */
import type { FastifyPluginAsync } from 'fastify';
import Anthropic from '@anthropic-ai/sdk';
import { EventEncoder } from '@ag-ui/encoder';
import { config } from '../lib/config.js';
import { FAST_MODEL } from '../lib/llm.js';

// ── AG-UI event helpers ─────────────────────────────────────────────────────

function evt(type: string, rest: Record<string, unknown> = {}): Record<string, unknown> {
  return { type, timestamp: Date.now(), ...rest };
}

// ── RunAgentInput ────────────────────────────────────────────────────────────
// Minimal subset of what Hashbrown sends — we only need the fields we act on.

interface AGUIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string;
  toolCallId?: string;
  /** tool_call_id alias used by some client versions */
  tool_call_id?: string;
  toolCalls?: Array<{ id: string; name: string; args: string }>;
}

interface AGUITool {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

interface RunAgentInput {
  threadId: string;
  runId: string;
  messages: AGUIMessage[];
  tools?: AGUITool[];
  context?: Array<{ description?: string; value?: string }>;
  state?: unknown;
}

// ── Anthropic message conversion ─────────────────────────────────────────────

function toAnthropicMessages(
  messages: AGUIMessage[],
): Array<{ role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[] }> {
  const out: Array<{ role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[] }> = [];
  for (const m of messages) {
    if (m.role === 'system') continue; // handled separately
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content ?? '' });
    } else if (m.role === 'assistant') {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of m.toolCalls ?? []) {
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: safeJson(tc.args),
        });
      }
      out.push({ role: 'assistant', content: blocks.length ? blocks : (m.content ?? '') });
    } else if (m.role === 'tool') {
      const tid = m.toolCallId ?? m.tool_call_id ?? 'unknown';
      out.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: tid, content: m.content ?? '' }],
      });
    }
  }
  return out;
}

function extractSystem(messages: AGUIMessage[]): string | undefined {
  const sys = messages.filter((m) => m.role === 'system').map((m) => m.content ?? '').join('\n');
  return sys || undefined;
}

function toAnthropicTools(tools?: AGUITool[]): Anthropic.Tool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    name: t.name,
    description: t.description ?? '',
    input_schema: (t.parameters ?? { type: 'object', properties: {} }) as Anthropic.Tool['input_schema'],
  }));
}

function safeJson(raw: string): Record<string, unknown> {
  try { return JSON.parse(raw) ?? {}; } catch { return {}; }
}

// ── Streaming core ────────────────────────────────────────────────────────────

async function* streamAGUI(input: RunAgentInput, apiKey: string) {
  const anthropic = new Anthropic({ apiKey });
  const { threadId, runId } = input;
  const stepId = crypto.randomUUID();

  yield evt('RUN_STARTED', { threadId, runId });
  yield evt('STEP_STARTED', { stepId });

  const messages = toAnthropicMessages(input.messages);
  const tools = toAnthropicTools(input.tools);
  const systemParts: string[] = [];

  const sys = extractSystem(input.messages);
  if (sys) systemParts.push(sys);
  for (const ctx of input.context ?? []) {
    if (ctx.description) systemParts.push(ctx.description);
    if (ctx.value) systemParts.push(ctx.value);
  }

  const stream = await anthropic.messages.stream({
    model: FAST_MODEL,
    max_tokens: 2048,
    ...(systemParts.length ? { system: systemParts.join('\n\n') } : {}),
    messages,
    ...(tools ? { tools } : {}),
  });

  let currentMessageId: string | null = null;
  let currentToolCallId: string | null = null;
  let parentMessageId: string | null = null;
  // Track which content block index is text vs tool_use
  const blockTypes: Map<number, 'text' | 'tool_use'> = new Map();

  for await (const event of stream) {
    const e = event as unknown as Record<string, unknown>;
    const type = e.type as string;
    const index = e.index as number | undefined;

    if (type === 'content_block_start') {
      const block = e.content_block as { type: string; id?: string; name?: string };
      blockTypes.set(index ?? 0, block.type as 'text' | 'tool_use');

      if (block.type === 'text') {
        currentMessageId = crypto.randomUUID();
        yield evt('TEXT_MESSAGE_START', { messageId: currentMessageId, role: 'assistant' });
      } else if (block.type === 'tool_use') {
        parentMessageId = currentMessageId ?? crypto.randomUUID();
        currentToolCallId = block.id ?? crypto.randomUUID();
        yield evt('TOOL_CALL_START', {
          toolCallId: currentToolCallId,
          toolCallName: block.name,
          parentMessageId,
        });
      }
    } else if (type === 'content_block_delta') {
      const delta = e.delta as { type: string; text?: string; partial_json?: string };
      const blockType = blockTypes.get(index ?? 0);

      if (blockType === 'text' && delta.type === 'text_delta' && currentMessageId) {
        yield evt('TEXT_MESSAGE_CHUNK', { messageId: currentMessageId, delta: delta.text ?? '' });
      } else if (blockType === 'tool_use' && delta.type === 'input_json_delta' && currentToolCallId) {
        yield evt('TOOL_CALL_ARGS', { toolCallId: currentToolCallId, delta: delta.partial_json ?? '' });
      }
    } else if (type === 'content_block_stop') {
      const blockType = blockTypes.get(index ?? 0);
      if (blockType === 'text' && currentMessageId) {
        yield evt('TEXT_MESSAGE_END', { messageId: currentMessageId });
        currentMessageId = null;
      } else if (blockType === 'tool_use' && currentToolCallId) {
        yield evt('TOOL_CALL_END', { toolCallId: currentToolCallId });
        currentToolCallId = null;
      }
      blockTypes.delete(index ?? 0);
    }
  }

  yield evt('STEP_FINISHED', { stepId });
  yield evt('RUN_FINISHED', { threadId, runId });
}

// ── Fastify route ────────────────────────────────────────────────────────────

export const generativeRoutes: FastifyPluginAsync = async (app) => {
  /** POST /api/generative/run — main Hashbrown streaming endpoint */
  app.post(
    '/run',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const apiKey = config.ANTHROPIC_API_KEY;
      if (!apiKey) {
        reply.code(503);
        return { error: 'ANTHROPIC_API_KEY is not configured' };
      }

      const input = request.body as RunAgentInput;
      if (!input?.threadId || !input?.runId || !Array.isArray(input?.messages)) {
        reply.code(400);
        return { error: 'Invalid RunAgentInput' };
      }

      const encoder = new EventEncoder();
      reply.raw.setHeader('Content-Type', encoder.getContentType());
      reply.raw.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.setHeader('X-Accel-Buffering', 'no');
      reply.raw.flushHeaders();

      try {
        for await (const agEvent of streamAGUI(input, apiKey)) {
          if (reply.raw.writableEnded) break;
          reply.raw.write(encoder.encodeSSE(agEvent as Parameters<EventEncoder['encodeSSE']>[0]));
        }
      } catch (err) {
        request.log.error(err, 'generative stream error');
        if (!reply.raw.writableEnded) {
          const errEvt = evt('RUN_ERROR', {
            threadId: input.threadId,
            runId: input.runId,
            message: err instanceof Error ? err.message : 'Stream error',
            code: 'STREAM_ERROR',
          });
          reply.raw.write(encoder.encodeSSE(errEvt as Parameters<EventEncoder['encodeSSE']>[0]));
        }
      } finally {
        if (!reply.raw.writableEnded) reply.raw.end();
      }
    },
  );
};
