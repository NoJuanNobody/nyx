import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { registerA2ACommand } from '../commands/a2a.js';

vi.mock('../client.js', () => ({
  NyxClient: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockResolvedValue([]),
    post: vi.fn().mockResolvedValue({ id: 'test-id' }),
    delete: vi.fn().mockResolvedValue({ removed: true }),
  })),
}));

describe('a2a command', () => {
  let program: Command;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mock('../client.js', () => ({
      NyxClient: vi.fn().mockImplementation(() => ({
        get: vi.fn().mockResolvedValue([]),
        post: vi.fn().mockResolvedValue({ id: 'test-id' }),
        delete: vi.fn().mockResolvedValue({ removed: true }),
      })),
    }));
    program = new Command();
    program.exitOverride();
    registerA2ACommand(program);
  });

  it('registers a2a command with subcommands', () => {
    const a2a = program.commands.find((c) => c.name() === 'a2a');
    expect(a2a).toBeDefined();
    const subcommands = a2a!.commands.map((c) => c.name());
    expect(subcommands).toContain('register');
    expect(subcommands).toContain('agents');
    expect(subcommands).toContain('channels');
    expect(subcommands).toContain('channel');
    expect(subcommands).toContain('send');
    expect(subcommands).toContain('messages');
    expect(subcommands).toContain('handoff');
  });

  it('register subcommand requires --team-id, --name, --platform', () => {
    const a2a = program.commands.find((c) => c.name() === 'a2a');
    const register = a2a!.commands.find((c) => c.name() === 'register');
    expect(register).toBeDefined();

    const teamIdOpt = register!.options.find((o) => o.long === '--team-id');
    expect(teamIdOpt).toBeDefined();
    expect(teamIdOpt!.required).toBe(true);

    const nameOpt = register!.options.find((o) => o.long === '--name');
    expect(nameOpt).toBeDefined();
    expect(nameOpt!.required).toBe(true);

    const platformOpt = register!.options.find((o) => o.long === '--platform');
    expect(platformOpt).toBeDefined();
    expect(platformOpt!.required).toBe(true);
  });

  it('agents subcommand requires --team-id', () => {
    const a2a = program.commands.find((c) => c.name() === 'a2a');
    const agents = a2a!.commands.find((c) => c.name() === 'agents');
    expect(agents).toBeDefined();

    const teamIdOpt = agents!.options.find((o) => o.long === '--team-id');
    expect(teamIdOpt).toBeDefined();
    expect(teamIdOpt!.required).toBe(true);
  });

  it('agents subcommand has optional --platform and --status', () => {
    const a2a = program.commands.find((c) => c.name() === 'a2a');
    const agents = a2a!.commands.find((c) => c.name() === 'agents');

    const platformOpt = agents!.options.find((o) => o.long === '--platform');
    expect(platformOpt).toBeDefined();
    expect(platformOpt!.mandatory).toBe(false);

    const statusOpt = agents!.options.find((o) => o.long === '--status');
    expect(statusOpt).toBeDefined();
    expect(statusOpt!.mandatory).toBe(false);
  });

  it('send subcommand accepts channelId argument', () => {
    const a2a = program.commands.find((c) => c.name() === 'a2a');
    const send = a2a!.commands.find((c) => c.name() === 'send');
    expect(send).toBeDefined();
    const args = send!.registeredArguments ?? [];
    expect(args.length).toBeGreaterThan(0);
    expect(args[0].name()).toBe('channelId');
  });

  it('handoff subcommand requires --from, --to, --doc-id', () => {
    const a2a = program.commands.find((c) => c.name() === 'a2a');
    const handoff = a2a!.commands.find((c) => c.name() === 'handoff');
    expect(handoff).toBeDefined();

    const fromOpt = handoff!.options.find((o) => o.long === '--from');
    expect(fromOpt).toBeDefined();
    expect(fromOpt!.required).toBe(true);

    const toOpt = handoff!.options.find((o) => o.long === '--to');
    expect(toOpt).toBeDefined();
    expect(toOpt!.required).toBe(true);

    const docOpt = handoff!.options.find((o) => o.long === '--doc-id');
    expect(docOpt).toBeDefined();
    expect(docOpt!.required).toBe(true);
  });

  it('messages subcommand accepts channelId argument', () => {
    const a2a = program.commands.find((c) => c.name() === 'a2a');
    const messages = a2a!.commands.find((c) => c.name() === 'messages');
    expect(messages).toBeDefined();
    const args = messages!.registeredArguments ?? [];
    expect(args.length).toBeGreaterThan(0);
    expect(args[0].name()).toBe('channelId');
  });

  it('all subcommands support --format option', () => {
    const a2a = program.commands.find((c) => c.name() === 'a2a');
    for (const sub of a2a!.commands) {
      // 'channel' is a parent command with its own subcommands
      if (sub.name() === 'channel') {
        for (const nested of sub.commands) {
          const formatOpt = nested.options.find((o) => o.long === '--format');
          expect(formatOpt).toBeDefined();
        }
      } else {
        const formatOpt = sub.options.find((o) => o.long === '--format');
        expect(formatOpt).toBeDefined();
      }
    }
  });

  it('channel create subcommand requires --team-id and --name', () => {
    const a2a = program.commands.find((c) => c.name() === 'a2a');
    const channel = a2a!.commands.find((c) => c.name() === 'channel');
    const create = channel!.commands.find((c) => c.name() === 'create');
    expect(create).toBeDefined();

    const teamIdOpt = create!.options.find((o) => o.long === '--team-id');
    expect(teamIdOpt).toBeDefined();
    expect(teamIdOpt!.required).toBe(true);

    const nameOpt = create!.options.find((o) => o.long === '--name');
    expect(nameOpt).toBeDefined();
    expect(nameOpt!.required).toBe(true);
  });
});
