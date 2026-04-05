import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { registerProposalsCommand } from '../commands/proposals.js';

vi.mock('../client.js', () => ({
  NyxClient: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockResolvedValue([]),
    post: vi.fn().mockResolvedValue({ id: 'proposal-1' }),
    patch: vi.fn().mockResolvedValue({ id: 'proposal-1', status: 'approved' }),
  })),
  resolveTeamId: vi.fn().mockReturnValue('team-1'),
  resolveDocId: vi.fn().mockResolvedValue('doc-1'),
}));

describe('proposals command', () => {
  let program: Command;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mock('../client.js', () => ({
      NyxClient: vi.fn().mockImplementation(() => ({
        get: vi.fn().mockResolvedValue([]),
        post: vi.fn().mockResolvedValue({ id: 'proposal-1' }),
        patch: vi.fn().mockResolvedValue({ id: 'proposal-1', status: 'approved' }),
      })),
      resolveTeamId: vi.fn().mockReturnValue('team-1'),
      resolveDocId: vi.fn().mockResolvedValue('doc-1'),
    }));
    program = new Command();
    program.exitOverride();
    registerProposalsCommand(program);
  });

  it('registers proposals command', () => {
    const proposals = program.commands.find((c) => c.name() === 'proposals');
    expect(proposals).toBeDefined();
  });

  it('registers list subcommand with doc-id argument', () => {
    const proposals = program.commands.find((c) => c.name() === 'proposals');
    expect(proposals).toBeDefined();
    const subcommands = proposals!.commands.map((c) => c.name());
    expect(subcommands).toContain('list');
  });

  it('registers generate subcommand with doc-id argument', () => {
    const proposals = program.commands.find((c) => c.name() === 'proposals');
    expect(proposals).toBeDefined();
    const subcommands = proposals!.commands.map((c) => c.name());
    expect(subcommands).toContain('generate');
  });

  it('registers approve subcommand with proposal-id argument', () => {
    const proposals = program.commands.find((c) => c.name() === 'proposals');
    expect(proposals).toBeDefined();
    const subcommands = proposals!.commands.map((c) => c.name());
    expect(subcommands).toContain('approve');
  });

  it('registers reject subcommand with proposal-id argument', () => {
    const proposals = program.commands.find((c) => c.name() === 'proposals');
    expect(proposals).toBeDefined();
    const subcommands = proposals!.commands.map((c) => c.name());
    expect(subcommands).toContain('reject');
  });

  it('registers push subcommand with proposal-id argument', () => {
    const proposals = program.commands.find((c) => c.name() === 'proposals');
    expect(proposals).toBeDefined();
    const subcommands = proposals!.commands.map((c) => c.name());
    expect(subcommands).toContain('push');
  });

  it('list subcommand accepts --status option', () => {
    const proposals = program.commands.find((c) => c.name() === 'proposals');
    const list = proposals!.commands.find((c) => c.name() === 'list');
    expect(list).toBeDefined();
    const statusOption = list!.options.find((o) => o.long === '--status');
    expect(statusOption).toBeDefined();
  });

  it('all subcommands accept --format option', () => {
    const proposals = program.commands.find((c) => c.name() === 'proposals');
    for (const sub of proposals!.commands) {
      const formatOption = sub.options.find((o) => o.long === '--format');
      expect(formatOption).toBeDefined();
    }
  });
});
