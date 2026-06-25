/**
 * Centralized LLM client (issue #450).
 *
 * This is the ONLY place that constructs a provider SDK client. Every service
 * obtains its client from here instead of doing `new Anthropic({ ... })`, so
 * switching providers (Anthropic ↔ OpenRouter) is a config change, not a
 * 12-file edit.
 *
 * OpenRouter speaks the OpenAI-compatible Chat Completions API, not the
 * Anthropic Messages API. Rather than rewrite every call site's request/response
 * handling, the OpenRouter path returns an **adapter that masquerades as an
 * Anthropic client**: it accepts Anthropic `messages.create(...)` params and
 * returns Anthropic-shaped responses, translating to/from OpenAI format
 * internally (including tool-use, so the agentic loop keeps working).
 */
import Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import { config } from './config.js';

export type LlmProvider = 'anthropic' | 'openrouter';

/** A client structurally compatible with the subset of the Anthropic SDK we use. */
export type LlmClient = Anthropic;

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

// ── Model resolution ─────────────────────────────────────────────────
// Default + fast model names are configurable (LLM_DEFAULT_MODEL /
// LLM_FAST_MODEL). When unset, fall back to sensible per-provider defaults so
// existing behavior is preserved for the anthropic path.
function resolveDefaultModel(provider: LlmProvider): string {
  if (config.LLM_DEFAULT_MODEL) return config.LLM_DEFAULT_MODEL;
  return provider === 'openrouter' ? 'anthropic/claude-sonnet-4' : 'claude-sonnet-4-6';
}

function resolveFastModel(provider: LlmProvider): string {
  if (config.LLM_FAST_MODEL) return config.LLM_FAST_MODEL;
  return provider === 'openrouter' ? 'anthropic/claude-3.5-haiku' : 'claude-haiku-4-5-20251001';
}

export const LLM_PROVIDER: LlmProvider = config.LLM_PROVIDER;
/** Default ("smart") model name for the active provider. */
export const DEFAULT_MODEL = resolveDefaultModel(LLM_PROVIDER);
/** Fast/cheap model name for the active provider. */
export const FAST_MODEL = resolveFastModel(LLM_PROVIDER);

export function isOpenRouter(): boolean {
  return LLM_PROVIDER === 'openrouter';
}

/** The platform-managed API key for the active provider (may be undefined). */
export function platformApiKey(): string | undefined {
  return isOpenRouter() ? config.OPENROUTER_API_KEY : config.ANTHROPIC_API_KEY;
}

// ── Client construction ──────────────────────────────────────────────

/**
 * Build an LLM client for an explicit API key. Used for BYOK (per-team keys).
 * The provider defaults to the globally configured one.
 */
export function createLlmClient(apiKey: string, provider: LlmProvider = LLM_PROVIDER): LlmClient {
  if (provider === 'openrouter') {
    return new OpenRouterAnthropicAdapter(apiKey) as unknown as Anthropic;
  }
  return new Anthropic({ apiKey });
}

/**
 * Build the platform LLM client from config, or `null` when no key is set.
 * This replaces the per-service
 *   `config.ANTHROPIC_API_KEY ? new Anthropic({ apiKey }) : null`
 * pattern.
 */
export function createPlatformLlmClient(): LlmClient | null {
  const key = platformApiKey();
  return key ? createLlmClient(key, LLM_PROVIDER) : null;
}

/**
 * Resolve the model names for a team, honoring the per-team selection saved via
 * the Settings model picker (teams.default_model / teams.fast_model), and
 * falling back to the globally configured defaults. Used on call paths that
 * carry a teamId (e.g. the agentic loop) so changing the model in the UI has a
 * real runtime effect. Dynamic imports avoid a circular dependency at module
 * load. Any failure falls back to the global defaults.
 */
export async function resolveTeamModels(
  teamId?: string,
): Promise<{ default: string; fast: string }> {
  const fallback = { default: DEFAULT_MODEL, fast: FAST_MODEL };
  if (!teamId) return fallback;
  try {
    const { db } = await import('../db/index.js');
    const { teams } = await import('../db/schema.js');
    const { eq } = await import('drizzle-orm');
    const [row] = await db
      .select({ defaultModel: teams.defaultModel, fastModel: teams.fastModel })
      .from(teams)
      .where(eq(teams.id, teamId))
      .limit(1);
    return {
      default: row?.defaultModel || DEFAULT_MODEL,
      fast: row?.fastModel || FAST_MODEL,
    };
  } catch {
    return fallback;
  }
}

// ── OpenRouter adapter (OpenAI format ⇄ Anthropic format) ─────────────

type AnyObj = Record<string, unknown>;

export function extractSystemText(system: Anthropic.MessageCreateParams['system']): string {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as unknown as AnyObj).text) : ''))
      .join('\n');
  }
  return '';
}

/** Tool_result content can be a string or an array of blocks; flatten to text. */
function toolResultToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && 'text' in (b as AnyObj) ? String((b as AnyObj).text) : ''))
      .join('');
  }
  return content == null ? '' : String(content);
}

export function mapAnthropicMessagesToOpenAI(
  systemText: string,
  messages: Anthropic.MessageParam[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  if (systemText) out.push({ role: 'system', content: systemText });

  for (const msg of messages) {
    const content = msg.content;

    if (typeof content === 'string') {
      out.push({ role: msg.role, content });
      continue;
    }
    if (!Array.isArray(content)) continue;

    if (msg.role === 'assistant') {
      let text = '';
      const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = [];
      for (const block of content) {
        const b = block as unknown as AnyObj;
        if (b.type === 'text') {
          text += String(b.text ?? '');
        } else if (b.type === 'tool_use') {
          toolCalls.push({
            id: String(b.id),
            type: 'function',
            function: { name: String(b.name), arguments: JSON.stringify(b.input ?? {}) },
          });
        }
      }
      const assistantMsg: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
        role: 'assistant',
        content: text || null,
      };
      if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
      out.push(assistantMsg);
    } else {
      // user message: text blocks become a user turn; tool_result blocks become
      // dedicated `tool` messages (which must follow the assistant tool_calls).
      let text = '';
      const toolMsgs: OpenAI.Chat.ChatCompletionToolMessageParam[] = [];
      for (const block of content) {
        const b = block as unknown as AnyObj;
        if (b.type === 'tool_result') {
          toolMsgs.push({
            role: 'tool',
            tool_call_id: String(b.tool_use_id),
            content: toolResultToText(b.content),
          });
        } else if (b.type === 'text') {
          text += String(b.text ?? '');
        }
      }
      for (const tm of toolMsgs) out.push(tm);
      if (text) out.push({ role: 'user', content: text });
    }
  }
  return out;
}

export function mapAnthropicToolsToOpenAI(
  tools: Anthropic.MessageCreateParams['tools'],
): OpenAI.Chat.ChatCompletionTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  const mapped: OpenAI.Chat.ChatCompletionTool[] = [];
  for (const t of tools as unknown as AnyObj[]) {
    if (!t || typeof t.name !== 'string') continue; // skip non-custom tool types
    mapped.push({
      type: 'function',
      function: {
        name: t.name,
        description: typeof t.description === 'string' ? t.description : undefined,
        parameters: (t.input_schema as AnyObj) ?? { type: 'object', properties: {} },
      },
    });
  }
  return mapped.length > 0 ? mapped : undefined;
}

function mapToolChoice(
  toolChoice: Anthropic.MessageCreateParams['tool_choice'],
): OpenAI.Chat.ChatCompletionCreateParams['tool_choice'] | undefined {
  if (!toolChoice) return undefined;
  const tc = toolChoice as unknown as AnyObj;
  if (tc.type === 'auto') return 'auto';
  if (tc.type === 'any') return 'required';
  if (tc.type === 'tool' && typeof tc.name === 'string') {
    return { type: 'function', function: { name: tc.name } };
  }
  return undefined;
}

export function mapFinishReason(reason: string | null | undefined): Anthropic.Message['stop_reason'] {
  switch (reason) {
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'stop':
    default:
      return 'end_turn';
  }
}

function safeJsonParse(raw: string): AnyObj {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as AnyObj) : {};
  } catch {
    return {};
  }
}

/**
 * Minimal Anthropic-client lookalike backed by OpenRouter. Only `messages.create`
 * (non-streaming) is implemented — the surface the codebase actually uses.
 */
class OpenRouterAnthropicAdapter {
  private apiKey: string;
  private clientPromise?: Promise<OpenAI>;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  // Lazily import the `openai` SDK so the (default) Anthropic path never pays
  // its load cost — only constructed on first OpenRouter call.
  private getClient(): Promise<OpenAI> {
    if (!this.clientPromise) {
      this.clientPromise = import('openai').then(
        ({ default: OpenAI }) =>
          new OpenAI({
            apiKey: this.apiKey,
            baseURL: config.LLM_BASE_URL || OPENROUTER_BASE_URL,
            defaultHeaders: {
              // OpenRouter attribution headers (recommended, optional).
              'HTTP-Referer': config.APP_URL || 'https://nyx-creative.com',
              'X-Title': 'Nyx',
            },
          }),
      );
    }
    return this.clientPromise;
  }

  messages = {
    create: async (
      params: Anthropic.MessageCreateParamsNonStreaming,
    ): Promise<Anthropic.Message> => {
      const openai = await this.getClient();
      const systemText = extractSystemText(params.system);
      const openaiMessages = mapAnthropicMessagesToOpenAI(systemText, params.messages);
      const tools = mapAnthropicToolsToOpenAI(params.tools);

      const completion = await openai.chat.completions.create({
        model: params.model,
        max_tokens: params.max_tokens,
        messages: openaiMessages,
        ...(tools ? { tools } : {}),
        ...(tools ? { tool_choice: mapToolChoice(params.tool_choice) } : {}),
        ...(typeof params.temperature === 'number' ? { temperature: params.temperature } : {}),
        ...(typeof params.top_p === 'number' ? { top_p: params.top_p } : {}),
      });

      const choice = completion.choices[0];
      const message = choice?.message;
      const content: Anthropic.ContentBlock[] = [];

      if (message?.content) {
        content.push({ type: 'text', text: message.content, citations: null });
      }
      for (const tc of message?.tool_calls ?? []) {
        if (tc.type !== 'function') continue;
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: safeJsonParse(tc.function.arguments),
        });
      }

      const usage = completion.usage;
      const cachedTokens =
        (usage as { prompt_tokens_details?: { cached_tokens?: number } } | undefined)
          ?.prompt_tokens_details?.cached_tokens ?? 0;

      return {
        id: completion.id,
        type: 'message',
        role: 'assistant',
        model: completion.model,
        content,
        stop_reason: mapFinishReason(choice?.finish_reason),
        stop_sequence: null,
        usage: {
          input_tokens: usage?.prompt_tokens ?? 0,
          output_tokens: usage?.completion_tokens ?? 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: cachedTokens,
          server_tool_use: null,
          service_tier: null,
        },
      } as Anthropic.Message;
    },

    // Streaming variant used by the RAG query path. Yields Anthropic-shaped
    // `content_block_delta` text events so `for await (event of stream)`
    // consumers work unchanged.
    stream: (params: Anthropic.MessageCreateParamsStreaming) => {
      const getClient = () => this.getClient();
      const systemText = extractSystemText(params.system);
      const openaiMessages = mapAnthropicMessagesToOpenAI(systemText, params.messages);
      async function* gen(): AsyncGenerator<{
        type: 'content_block_delta';
        index: number;
        delta: { type: 'text_delta'; text: string };
      }> {
        const openai = await getClient();
        const completion = await openai.chat.completions.create({
          model: params.model,
          max_tokens: params.max_tokens,
          messages: openaiMessages,
          stream: true,
          ...(typeof params.temperature === 'number' ? { temperature: params.temperature } : {}),
        });
        for await (const chunk of completion) {
          const text = chunk.choices[0]?.delta?.content;
          if (text) {
            yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } };
          }
        }
      }
      return gen();
    },
  };
}
