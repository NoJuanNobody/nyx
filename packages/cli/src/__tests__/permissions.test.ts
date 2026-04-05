import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { registerPermissionsCommand } from '../commands/permissions.js';

vi.mock('../client.js', () => ({
  NyxClient: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockResolvedValue({
      allowed: true,
      role: 'admin',
      requiredRole: 'editor',
    }),
  })),
  resolveTeamId: vi.fn().mockReturnValue('team-1'),
  resolveDocId: vi.fn().mockResolvedValue('doc-1'),
>>>>>>> feat/issue-141-multi-agent-orchestration
}));

describe('permissions command', () => {
  let program: Command;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mock('../client.js', () => ({
      NyxClient: vi.fn().mockImplementation(() => ({
        get: vi.fn().mockResolvedValue({
          allowed: true,
          role: 'admin',
          requiredRole: 'editor',
        }),
      })),
<<<<<<< HEAD
      resolveTeamId: vi.fn().mockReturnValue('team-1'),
      resolveDocId: vi.fn().mockResolvedValue('doc-1'),
=======
    }));
    program = new Command();
    program.exitOverride();
    registerPermissionsCommand(program);
  });

  it('registers permissions command with subcommands', () => {
    const perms = program.commands.find((c) => c.name() === 'permissions');
    expect(perms).toBeDefined();
    const subcommands = perms!.commands.map((c) => c.name());
    expect(subcommands).toContain('check');
    expect(subcommands).toContain('roles');
  });

  it('check subcommand requires --team-id and --action', () => {
    const perms = program.commands.find((c) => c.name() === 'permissions');
    const check = perms!.commands.find((c) => c.name() === 'check');
    expect(check).toBeDefined();

    const options = check!.options.map((o) => o.long);
    expect(options).toContain('--team-id');
    expect(options).toContain('--action');
    expect(options).toContain('--resource-type');
    expect(options).toContain('--resource-id');
    expect(options).toContain('--format');
  });

  it('roles subcommand requires --team-id', () => {
    const perms = program.commands.find((c) => c.name() === 'permissions');
    const roles = perms!.commands.find((c) => c.name() === 'roles');
    expect(roles).toBeDefined();

    const options = roles!.options.map((o) => o.long);
    expect(options).toContain('--team-id');
    expect(options).toContain('--format');
  });
});
