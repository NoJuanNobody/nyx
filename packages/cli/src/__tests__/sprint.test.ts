import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { registerSprintCommand } from '../commands/sprint.js';

vi.mock('../client.js', () => ({
  NyxClient: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockResolvedValue({ totalCapacity: 40, usedCapacity: 25, remainingCapacity: 15 }),
    post: vi.fn().mockResolvedValue({ allowed: true, remaining: 12 }),
  })),
}));

describe('sprint command', () => {
  let program: Command;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mock('../client.js', () => ({
      NyxClient: vi.fn().mockImplementation(() => ({
        get: vi.fn().mockResolvedValue({ totalCapacity: 40, usedCapacity: 25, remainingCapacity: 15 }),
        post: vi.fn().mockResolvedValue({ allowed: true, remaining: 12 }),
      })),
    }));
    program = new Command();
    program.exitOverride();
    registerSprintCommand(program);
  });

  it('registers sprint command with subcommands', () => {
    const sprint = program.commands.find((c) => c.name() === 'sprint');
    expect(sprint).toBeDefined();
    const subcommands = sprint!.commands.map((c) => c.name());
    expect(subcommands).toContain('status');
    expect(subcommands).toContain('check');
    expect(subcommands).toContain('defer');
    expect(subcommands).toContain('weight');
  });

  it('status subcommand requires --team-id', () => {
    const sprint = program.commands.find((c) => c.name() === 'sprint');
    const status = sprint!.commands.find((c) => c.name() === 'status');
    expect(status).toBeDefined();
    const teamIdOption = status!.options.find((o) => o.long === '--team-id');
    expect(teamIdOption).toBeDefined();
    expect(teamIdOption!.required).toBe(true);
  });

  it('check subcommand has optional --weight', () => {
    const sprint = program.commands.find((c) => c.name() === 'sprint');
    const check = sprint!.commands.find((c) => c.name() === 'check');
    expect(check).toBeDefined();
    const weightOption = check!.options.find((o) => o.long === '--weight');
    expect(weightOption).toBeDefined();
    // --weight is defined via .option() (not .requiredOption()), so it is optional
    expect(weightOption!.mandatory).toBe(false);
  });

  it('defer subcommand accepts a ticket-id argument', () => {
    const sprint = program.commands.find((c) => c.name() === 'sprint');
    const defer = sprint!.commands.find((c) => c.name() === 'defer');
    expect(defer).toBeDefined();
    // Commander stores the argument name
    const args = defer!.registeredArguments ?? [];
    expect(args.length).toBeGreaterThan(0);
    expect(args[0].name()).toBe('ticketId');
  });

  it('weight subcommand accepts a doc-id argument', () => {
    const sprint = program.commands.find((c) => c.name() === 'sprint');
    const weight = sprint!.commands.find((c) => c.name() === 'weight');
    expect(weight).toBeDefined();
    const args = weight!.registeredArguments ?? [];
    expect(args.length).toBeGreaterThan(0);
    expect(args[0].name()).toBe('docId');
  });

  it('all subcommands support --format option', () => {
    const sprint = program.commands.find((c) => c.name() === 'sprint');
    for (const sub of sprint!.commands) {
      const formatOpt = sub.options.find((o) => o.long === '--format');
      expect(formatOpt).toBeDefined();
    }
  });
});
