import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerCreditsCommand } from '../commands/credits.js';

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../client.js', () => ({
  NyxClient: class {
    get = get;
    post = post;
  },
}));

let out: string[];
let program: Command;

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  out = [];
  vi.spyOn(console, 'log').mockImplementation((m?: unknown) => {
    out.push(String(m));
  });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit:${code}`);
  }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  delete process.env.NYX_AGENT_ID;
  program = new Command();
  program.exitOverride();
  registerCreditsCommand(program);
});
afterEach(() => {
  vi.mocked(console.log).mockRestore();
  vi.mocked(process.exit).mockRestore();
});

const run = (...args: string[]) => program.parseAsync(['node', 'nyx', 'credits', ...args]);

describe('nyx credits', () => {
  it('registers metering subcommands and no purchase/plan ones', () => {
    const names = program.commands.find((c) => c.name() === 'credits')!.commands.map((c) => c.name());
    expect(names).toEqual(expect.arrayContaining(['balance', 'reserve', 'commit', 'release', 'spend']));
    expect(names.join(' ')).not.toMatch(/purchase|buy|checkout|plan|pack|subscri/);
  });

  it('balance --json prints raw JSON for the agent', async () => {
    get.mockResolvedValue({ available: 42 });
    await run('balance', '--agent', 'cursor', '--json');
    expect(get).toHaveBeenCalledWith('/api/credits/balance?agentId=cursor');
    expect(JSON.parse(out[0])).toEqual({ available: 42 });
  });

  it('reserve sends a generated idempotency key in body and header', async () => {
    post.mockResolvedValue({ reservationId: 'le_9' });
    await run('reserve', '5', '--task-type', 'scan', '--json');
    const [path, body, headers] = post.mock.calls[0];
    expect(path).toBe('/api/credits/reserve');
    expect(body).toMatchObject({ agentId: 'default', amount: 5, taskType: 'scan' });
    expect(body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(headers['Idempotency-Key']).toBe(body.idempotencyKey);
    expect(JSON.parse(out[0])).toEqual({ reservationId: 'le_9' });
  });

  it('honors --idempotency-key for spend', async () => {
    post.mockResolvedValue({ replayed: true });
    await run('spend', '2', '--idempotency-key', 'abc-123', '--json');
    expect(post.mock.calls[0][1].idempotencyKey).toBe('abc-123');
    expect(post.mock.calls[0][0]).toBe('/api/credits/spend');
  });

  it('commit and release post to their endpoints', async () => {
    post.mockResolvedValue({});
    await run('commit', 'le_1', '0', '--json');
    await run('release', 'le_1', '--json');
    expect(post.mock.calls[0][0]).toBe('/api/credits/commit');
    expect(post.mock.calls[0][1]).toMatchObject({ reservationId: 'le_1', actualAmount: 0 });
    expect(post.mock.calls[1][0]).toBe('/api/credits/release');
  });

  it('rejects non-integer amounts without calling the API', async () => {
    await expect(run('spend', '1.5')).rejects.toThrow('exit:1');
    expect(post).not.toHaveBeenCalled();
  });

  it('--json failure prints the structured API error and exits 1', async () => {
    post.mockRejectedValue(
      new Error('API error 402: {"error":"insufficient_credits","available":1,"required":5}'),
    );
    await expect(run('spend', '5', '--json')).rejects.toThrow('exit:1');
    expect(JSON.parse(out[0])).toEqual({ error: 'insufficient_credits', available: 1, required: 5 });
  });
});
