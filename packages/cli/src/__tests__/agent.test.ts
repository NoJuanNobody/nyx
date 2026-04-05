import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { registerAgentCommand } from '../commands/agent.js';

const mockGet = vi.fn();

vi.mock('../client.js', () => ({
  NyxClient: vi.fn().mockImplementation(() => ({
    get: (...args: unknown[]) => mockGet(...args),
  })),
  resolveTeamId: vi.fn().mockReturnValue('team-1'),
  resolveDocId: vi.fn().mockResolvedValue('doc-1'),
}));

describe('agent command', () => {
  let program: Command;

  beforeEach(() => {
    mockGet.mockReset();
    program = new Command();
    program.exitOverride();
    registerAgentCommand(program);
  });

  it('registers agent command with subcommands', () => {
    const agent = program.commands.find((c) => c.name() === 'agent');
    expect(agent).toBeDefined();
    const subcommands = agent!.commands.map((c) => c.name());
    expect(subcommands).toContain('sessions');
    expect(subcommands).toContain('workflows');
  });

  it('sessions calls GET /api/agent/sessions with teamId', async () => {
    const sessions = [
      { id: 's1', status: 'active', agentType: 'drift' },
      { id: 's2', status: 'completed', agentType: 'spec' },
    ];
    mockGet.mockResolvedValue(sessions);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await program.parseAsync(['node', 'nyx', 'agent', 'sessions', '--team-id', 'team-1', '--format', 'json']);

    expect(mockGet).toHaveBeenCalledWith('/api/agent/sessions?teamId=team-1');
    expect(log).toHaveBeenCalled();
    const output = JSON.parse(log.mock.calls[0][0] as string);
    expect(output).toHaveLength(2);
    log.mockRestore();
  });

  it('sessions filters by --status client-side', async () => {
    const sessions = [
      { id: 's1', status: 'active', agentType: 'drift' },
      { id: 's2', status: 'completed', agentType: 'spec' },
      { id: 's3', status: 'active', agentType: 'review' },
    ];
    mockGet.mockResolvedValue(sessions);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await program.parseAsync([
      'node', 'nyx', 'agent', 'sessions',
      '--team-id', 'team-1',
      '--status', 'active',
      '--format', 'json',
    ]);

    const output = JSON.parse(log.mock.calls[0][0] as string);
    expect(output).toHaveLength(2);
    expect(output.every((s: { status: string }) => s.status === 'active')).toBe(true);
    log.mockRestore();
  });

  it('sessions passes --limit to API', async () => {
    mockGet.mockResolvedValue([]);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await program.parseAsync([
      'node', 'nyx', 'agent', 'sessions',
      '--team-id', 'team-1',
      '--limit', '5',
    ]);

    expect(mockGet).toHaveBeenCalledWith('/api/agent/sessions?teamId=team-1&limit=5');
    log.mockRestore();
  });

  it('workflows calls GET /api/agent/workflows', async () => {
    const workflows = [
      { id: 'w1', name: 'Drift Detection', description: 'Detect drift', defaultPrompt: 'p', postSessionSuggestions: [] },
    ];
    mockGet.mockResolvedValue(workflows);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await program.parseAsync(['node', 'nyx', 'agent', 'workflows']);

    expect(mockGet).toHaveBeenCalledWith('/api/agent/workflows');
    expect(log).toHaveBeenCalled();
    const output = JSON.parse(log.mock.calls[0][0] as string);
    expect(output).toHaveLength(1);
    expect(output[0].name).toBe('Drift Detection');
    log.mockRestore();
  });
});
