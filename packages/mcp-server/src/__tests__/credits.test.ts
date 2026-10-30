import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configure } from '../auth.js';
import {
  CREDIT_TOOL_DEFINITIONS,
  creditSchemas,
  executeCreditTool,
  isCreditTool,
} from '../credits.js';
import { TOOL_DEFINITIONS } from '../tools.js';

const fetchMock = vi.fn();

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  configure({ apiKey: 'k', baseUrl: 'http://api.test' });
  delete process.env.NYX_AGENT_ID;
});
afterEach(() => vi.unstubAllGlobals());

describe('credit tool definitions', () => {
  it('are exposed by the server and have matching schemas', () => {
    for (const d of CREDIT_TOOL_DEFINITIONS) {
      expect(TOOL_DEFINITIONS.map((t) => t.name)).toContain(d.name);
      expect(isCreditTool(d.name)).toBe(true);
    }
    expect(Object.keys(creditSchemas).sort()).toEqual(CREDIT_TOOL_DEFINITIONS.map((d) => d.name).sort());
  });

  it('exposes no purchase/billing/plan tools', () => {
    const names = TOOL_DEFINITIONS.map((t) => t.name).join(' ');
    expect(names).not.toMatch(/purchase|billing|checkout|plan|pack|subscri/i);
  });
});

describe('executeCreditTool', () => {
  it('balance GETs for the default agent', async () => {
    fetchMock.mockResolvedValue(ok({ available: 7 }));
    expect(await executeCreditTool('nyx_credits_balance', {})).toEqual({ available: 7 });
    expect(fetchMock.mock.calls[0][0]).toBe('http://api.test/api/credits/balance?agentId=default');
  });

  it('balance uses NYX_AGENT_ID and explicit agent_id', async () => {
    fetchMock.mockResolvedValue(ok({}));
    process.env.NYX_AGENT_ID = 'cursor';
    await executeCreditTool('nyx_credits_balance', {});
    expect(fetchMock.mock.calls[0][0]).toContain('agentId=cursor');
    await executeCreditTool('nyx_credits_balance', { agent_id: 'claude-code' });
    expect(fetchMock.mock.calls[1][0]).toContain('agentId=claude-code');
  });

  it('reserve POSTs idempotency key in body and header', async () => {
    fetchMock.mockResolvedValue(ok({ reservationId: 'le_1' }));
    await executeCreditTool('nyx_credits_reserve', {
      idempotency_key: 'call-12345',
      amount: 3,
      task_type: 'scan',
      ttl_ms: 60000,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://api.test/api/credits/reserve');
    expect(init.method).toBe('POST');
    expect(init.headers['Idempotency-Key']).toBe('call-12345');
    expect(init.headers.Authorization).toBe('Bearer k');
    expect(JSON.parse(init.body)).toEqual({
      idempotencyKey: 'call-12345',
      agentId: 'default',
      amount: 3,
      taskType: 'scan',
      ttlMs: 60000,
    });
  });

  it('commit, release and spend hit their endpoints', async () => {
    fetchMock.mockResolvedValue(ok({}));
    await executeCreditTool('nyx_credits_commit', { idempotency_key: 'key-00001', reservation_id: 'le_1', actual_amount: 0 });
    await executeCreditTool('nyx_credits_release', { idempotency_key: 'key-00002', reservation_id: 'le_1' });
    await executeCreditTool('nyx_credits_spend', { idempotency_key: 'key-00003', amount: 2 });
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      'http://api.test/api/credits/commit',
      'http://api.test/api/credits/release',
      'http://api.test/api/credits/spend',
    ]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ reservationId: 'le_1', actualAmount: 0 });
  });

  it('rejects invalid input without calling the API', async () => {
    await expect(executeCreditTool('nyx_credits_spend', { amount: 2 })).rejects.toThrow(/idempotency_key/);
    await expect(
      executeCreditTool('nyx_credits_spend', { idempotency_key: 'key-00001', amount: 1.5 }),
    ).rejects.toThrow(/amount/);
    await expect(
      executeCreditTool('nyx_credits_reserve', { idempotency_key: 'key-00001', amount: 1, agent_id: 'a:b' }),
    ).rejects.toThrow(/agent_id/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces structured insufficient_credits errors', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 402,
      statusText: 'Payment Required',
      text: async () => JSON.stringify({ error: 'insufficient_credits', available: 1, required: 5 }),
    } as Response);
    await expect(
      executeCreditTool('nyx_credits_spend', { idempotency_key: 'key-00001', amount: 5 }),
    ).rejects.toThrow(/insufficient_credits.*available.*required/);
  });
});
