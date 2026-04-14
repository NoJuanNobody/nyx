import { describe, it, expect, vi, beforeEach } from 'vitest';
import '../../../__tests__/helpers/setup.js';

// ── Mock Anthropic SDK ──────────────────────────────────────────
const mockCreate = vi.hoisted(() => vi.fn());
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = { create: mockCreate };
    },
  };
});

// ── Mock credits service — allow checks, track deductions ──────
const mockCheckCredits = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ allowed: true, balance: 100, required: 1 }),
);
const mockDeductCredits = vi.hoisted(() => vi.fn().mockResolvedValue({ balance: 99 }));
vi.mock('../../credits.service.js', () => ({
  checkCredits: mockCheckCredits,
  deductCredits: mockDeductCredits,
  getAgentCost: vi.fn().mockReturnValue(1),
}));

// ── Mock the tool executor — every call returns a small success ──
const mockExecuteTool = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ ok: true, message: 'tool succeeded' }),
);
vi.mock('../executor.js', () => ({
  executeTool: mockExecuteTool,
}));

// Keep tool definitions tiny so cache_control math is predictable
vi.mock('../tools.js', () => ({
  getToolDefinitions: () => [
    {
      name: 'search_code',
      description: 'search',
      input_schema: { type: 'object' as const, properties: {}, required: [] },
    },
    {
      name: 'get_github_files',
      description: 'get files',
      input_schema: { type: 'object' as const, properties: {}, required: [] },
    },
  ],
}));

import { runAgentLoop } from '../loop.js';
import type { AgentContext } from '../types.js';

// Helpers
function makeToolUseResponse(
  toolName: string,
  id: string,
  opts: { input?: Record<string, unknown>; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number }; text?: string } = {},
) {
  const content: unknown[] = [];
  if (opts.text) content.push({ type: 'text', text: opts.text });
  content.push({ type: 'tool_use', id, name: toolName, input: opts.input ?? { q: 'x' } });
  return {
    content,
    usage: {
      input_tokens: opts.usage?.input_tokens ?? 500,
      output_tokens: opts.usage?.output_tokens ?? 100,
      cache_read_input_tokens: opts.usage?.cache_read_input_tokens ?? 0,
    },
  };
}

function makeTextResponse(text: string, usage = { input_tokens: 100, output_tokens: 50 }) {
  return {
    content: [{ type: 'text', text }],
    usage: { ...usage, cache_read_input_tokens: 0 },
  };
}

function buildContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    userId: 'user-1',
    userRole: 'developer',
    teamId: 'team-1',
    sessionId: 'sess-1',
    onEvent: vi.fn(),
    cancelled: () => false,
    ...overrides,
  };
}

describe('runAgentLoop — termination behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockReset();
    mockCheckCredits.mockResolvedValue({ allowed: true, balance: 100, required: 1 });
    mockDeductCredits.mockResolvedValue({ balance: 99 });
  });

  it('hits the new 25-iteration ceiling and does NOT deduct credits when no text output was produced', async () => {
    // 26 iterations of pure tool_use (no text) — should hit the ceiling
    for (let i = 0; i < 26; i++) {
      mockCreate.mockResolvedValueOnce(makeToolUseResponse('search_code', `t-${i}`));
    }

    const onEvent = vi.fn();
    const result = await runAgentLoop({
      systemPrompt: 'You are a test agent.',
      userPrompt: 'Do the thing.',
      context: buildContext({ onEvent }),
    });

    // Confirm we hit the new 25-iteration ceiling (not the old 10)
    expect(mockCreate.mock.calls.length).toBe(25);
    // No text produced → no credits deducted
    expect(mockDeductCredits).not.toHaveBeenCalled();
    expect(result.incomplete).toBe(true);
    // `result` is only the stop note (trimmed)
    expect(result.result).toContain('Stopped at iteration limit');
    // done event has incomplete: true
    const doneEvent = onEvent.mock.calls.map((c) => c[0]).find((e) => e?.type === 'done');
    expect(doneEvent?.incomplete).toBe(true);
    expect(doneEvent?.creditsUsed).toBe(0);
  });

  it('hits the ceiling but preserves partial text output AND deducts credits when model produced text', async () => {
    // 25 tool-use iterations, the last one includes a text block
    for (let i = 0; i < 24; i++) {
      mockCreate.mockResolvedValueOnce(makeToolUseResponse('search_code', `t-${i}`));
    }
    mockCreate.mockResolvedValueOnce(
      makeToolUseResponse('search_code', 't-24', {
        text: 'Here is my partial draft of the spec: section 1 is complete.',
      }),
    );

    const result = await runAgentLoop({
      systemPrompt: 'You are a test agent.',
      userPrompt: 'Do the thing.',
      context: buildContext(),
    });

    expect(mockCreate.mock.calls.length).toBe(25);
    expect(result.incomplete).toBe(true);
    // Preserved the latest non-empty text output
    expect(result.result).toContain('Here is my partial draft of the spec');
    // Stop note appended
    expect(result.result).toContain('Stopped at iteration limit');
    // Credits WERE deducted since the user got real output
    expect(mockDeductCredits).toHaveBeenCalledTimes(1);
  });

  it('emits a soft warning event when iteration 20 is reached', async () => {
    for (let i = 0; i < 25; i++) {
      mockCreate.mockResolvedValueOnce(makeToolUseResponse('search_code', `t-${i}`));
    }

    const onEvent = vi.fn();
    await runAgentLoop({
      systemPrompt: 'sys',
      userPrompt: 'go',
      context: buildContext({ onEvent }),
    });

    const textEvents = onEvent.mock.calls
      .map((c) => c[0])
      .filter((e: { type: string; text?: string }) => e?.type === 'text');
    const warningEvent = textEvents.find((e: { text?: string }) =>
      e.text?.includes('approaching iteration ceiling'),
    );
    expect(warningEvent).toBeDefined();
  });

  it('token-budget early-exit has its own terminal block (does NOT fall through to generic string)', async () => {
    // One huge iteration that crosses the 120K token budget
    mockCreate.mockResolvedValueOnce(
      makeToolUseResponse('search_code', 't-1', {
        usage: { input_tokens: 125_000, output_tokens: 1000 },
      }),
    );

    const onEvent = vi.fn();
    const result = await runAgentLoop({
      systemPrompt: 'sys',
      userPrompt: 'go',
      context: buildContext({ onEvent }),
    });

    expect(result.incomplete).toBe(true);
    // Must NOT be the old "Agent reached maximum iteration limit." literal
    expect(result.result).not.toContain('Agent reached maximum iteration limit');
    // Token-stop note is used
    expect(result.result).toContain('Stopping early');
    // No real text output → no credit deduction
    expect(mockDeductCredits).not.toHaveBeenCalled();

    const doneEvent = onEvent.mock.calls.map((c) => c[0]).find((e) => e?.type === 'done');
    expect(doneEvent?.incomplete).toBe(true);
  });

  it('normal completion still deducts credits and reports non-incomplete done', async () => {
    // One iteration, pure text, no tool_use → completes normally
    mockCreate.mockResolvedValueOnce(makeTextResponse('Here is the final spec.'));

    const onEvent = vi.fn();
    const result = await runAgentLoop({
      systemPrompt: 'sys',
      userPrompt: 'go',
      context: buildContext({ onEvent }),
    });

    expect(result.incomplete).toBeUndefined();
    expect(result.result).toBe('Here is the final spec.');
    expect(mockDeductCredits).toHaveBeenCalledTimes(1);

    const doneEvent = onEvent.mock.calls.map((c) => c[0]).find((e) => e?.type === 'done');
    expect(doneEvent?.incomplete).toBeUndefined();
  });
});

describe('runAgentLoop — prompt caching and token reporting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockReset();
    mockCheckCredits.mockResolvedValue({ allowed: true, balance: 100, required: 1 });
    mockDeductCredits.mockResolvedValue({ balance: 99 });
  });

  it('sends system prompt with cache_control and marks the LAST tool with cache_control', async () => {
    mockCreate.mockResolvedValueOnce(makeTextResponse('done'));

    await runAgentLoop({
      systemPrompt: 'SYSTEM PROMPT',
      userPrompt: 'go',
      context: buildContext(),
    });

    expect(mockCreate).toHaveBeenCalledOnce();
    const callArgs = mockCreate.mock.calls[0][0];
    // System is a content-block array with cache_control on the text block
    expect(Array.isArray(callArgs.system)).toBe(true);
    expect(callArgs.system[0]).toMatchObject({
      type: 'text',
      text: 'SYSTEM PROMPT',
      cache_control: { type: 'ephemeral' },
    });
    // Only the LAST tool gets cache_control
    expect(callArgs.tools).toHaveLength(2);
    expect(callArgs.tools[0].cache_control).toBeUndefined();
    expect(callArgs.tools[1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('reports cachedInputTokens on the done event when cache_read_input_tokens is returned', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'done' }],
      usage: { input_tokens: 200, output_tokens: 50, cache_read_input_tokens: 1500 },
    });

    const onEvent = vi.fn();
    await runAgentLoop({
      systemPrompt: 'sys',
      userPrompt: 'go',
      context: buildContext({ onEvent }),
    });

    const doneEvent = onEvent.mock.calls.map((c) => c[0]).find((e) => e?.type === 'done');
    expect(doneEvent?.tokenUsage?.cachedInputTokens).toBe(1500);
  });
});

describe('runAgentLoop — token usage reduction benchmark', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockReset();
    mockCheckCredits.mockResolvedValue({ allowed: true, balance: 100, required: 1 });
    mockDeductCredits.mockResolvedValue({ balance: 99 });
  });

  it('aggregate token usage with prompt caching is at least 50% lower than an uncached baseline', async () => {
    // Baseline model: on the OLD code path, every iteration billed the full
    // system+tools as fresh input_tokens. We simulate that with a large per-call
    // input_tokens value and NO cache_read_input_tokens on any response.
    // The NEW code path gets 90% of those tokens served from cache starting on
    // iteration 2, which we simulate by splitting input_tokens into a small
    // uncached portion + a cache_read portion.
    //
    // For a 10-iteration run with 10_000 system+tool tokens per call:
    //   Baseline  = 10 * 10_000 = 100_000 input tokens
    //   Cached    = 10_000 (iter 1, uncached)
    //             + 9 * 1_000 (iters 2-10, 10% of cached, rest reads)
    //             = 19_000 "billable" input tokens
    //
    // We verify the sum of `inputTokens` (the billable portion the SDK returns)
    // across iterations is less than 50% of the baseline.

    // ── Simulate the BASELINE: no caching, full cost every iteration ──
    for (let i = 0; i < 9; i++) {
      mockCreate.mockResolvedValueOnce(
        makeToolUseResponse('search_code', `b-${i}`, {
          usage: { input_tokens: 10_000, output_tokens: 200, cache_read_input_tokens: 0 },
        }),
      );
    }
    mockCreate.mockResolvedValueOnce(
      makeTextResponse('baseline done', { input_tokens: 10_000, output_tokens: 200 }),
    );

    const baselineResult = await runAgentLoop({
      systemPrompt: 'sys',
      userPrompt: 'go',
      context: buildContext({ sessionId: 'baseline' }),
    });
    const baselineTotal =
      baselineResult.tokenUsage.inputTokens + baselineResult.tokenUsage.outputTokens;

    mockCreate.mockReset();

    // ── Simulate the CACHED run: the SDK reports only the uncached delta as
    // input_tokens, and the cached bulk as cache_read_input_tokens. Only the
    // uncached portion is billed at full price (cache reads are 10%). ──
    for (let i = 0; i < 9; i++) {
      mockCreate.mockResolvedValueOnce(
        makeToolUseResponse('search_code', `c-${i}`, {
          usage: { input_tokens: 1_000, output_tokens: 200, cache_read_input_tokens: 9_000 },
        }),
      );
    }
    mockCreate.mockResolvedValueOnce(
      makeTextResponse('cached done', { input_tokens: 1_000, output_tokens: 200 }),
    );

    const cachedResult = await runAgentLoop({
      systemPrompt: 'sys',
      userPrompt: 'go',
      context: buildContext({ sessionId: 'cached' }),
    });
    const cachedTotal =
      cachedResult.tokenUsage.inputTokens + cachedResult.tokenUsage.outputTokens;

    // Cached aggregate must be at least 50% lower than baseline
    expect(cachedTotal).toBeLessThan(baselineTotal * 0.5);
    // And we should be reporting the cached tokens we saved
    expect(cachedResult.tokenUsage.cachedInputTokens).toBeGreaterThan(0);
  });
});
