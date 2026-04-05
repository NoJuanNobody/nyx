import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { registerAuditCommand, registerActivityCommand } from '../commands/audit.js';

vi.mock('../client.js', () => ({
  NyxClient: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockResolvedValue({ documentId: 'doc-1', events: [] }),
  })),
  resolveTeamId: vi.fn().mockReturnValue('team-1'),
  resolveDocId: vi.fn().mockResolvedValue('doc-1'),
}));

describe('audit command', () => {
  let program: Command;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mock('../client.js', () => ({
      NyxClient: vi.fn().mockImplementation(() => ({
        get: vi.fn().mockResolvedValue({ documentId: 'doc-1', events: [] }),
      })),
      resolveTeamId: vi.fn().mockReturnValue('team-1'),
      resolveDocId: vi.fn().mockResolvedValue('doc-1'),
    }));
    program = new Command();
    program.exitOverride();
    registerAuditCommand(program);
  });

  it('registers audit command with doc-id argument', () => {
    const audit = program.commands.find((c) => c.name() === 'audit');
    expect(audit).toBeDefined();
  });

  it('registers trace subcommand', () => {
    const audit = program.commands.find((c) => c.name() === 'audit');
    expect(audit).toBeDefined();
    const subcommands = audit!.commands.map((c) => c.name());
    expect(subcommands).toContain('trace');
  });
});

describe('activity command', () => {
  let program: Command;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mock('../client.js', () => ({
      NyxClient: vi.fn().mockImplementation(() => ({
        get: vi.fn().mockResolvedValue({ teamId: 'team-1', events: [] }),
      })),
      resolveTeamId: vi.fn().mockReturnValue('team-1'),
      resolveDocId: vi.fn().mockResolvedValue('doc-1'),
    }));
    program = new Command();
    program.exitOverride();
    registerActivityCommand(program);
  });

  it('registers activity command', () => {
    const activity = program.commands.find((c) => c.name() === 'activity');
    expect(activity).toBeDefined();
  });

  it('activity command requires --team-id option', () => {
    const activity = program.commands.find((c) => c.name() === 'activity');
    expect(activity).toBeDefined();
    const teamIdOption = activity!.options.find((o) => o.long === '--team-id');
    expect(teamIdOption).toBeDefined();
    expect(teamIdOption!.required).toBe(true);
  });

  it('activity command accepts --limit option', () => {
    const activity = program.commands.find((c) => c.name() === 'activity');
    expect(activity).toBeDefined();
    const limitOption = activity!.options.find((o) => o.long === '--limit');
    expect(limitOption).toBeDefined();
  });
});
