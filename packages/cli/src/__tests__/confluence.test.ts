import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { registerConfluenceCommand } from '../commands/confluence.js';

vi.mock('../client.js', () => ({
  NyxClient: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockResolvedValue([{ key: 'ENG', name: 'Engineering' }]),
    post: vi.fn().mockResolvedValue({ documentId: 'doc-1', qualityScore: 8, status: 'active' }),
  })),
}));

describe('confluence command', () => {
  let program: Command;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mock('../client.js', () => ({
      NyxClient: vi.fn().mockImplementation(() => ({
        get: vi.fn().mockResolvedValue([{ key: 'ENG', name: 'Engineering' }]),
        post: vi.fn().mockResolvedValue({ documentId: 'doc-1', qualityScore: 8, status: 'active' }),
      })),
    }));
    program = new Command();
    program.exitOverride();
    registerConfluenceCommand(program);
  });

  it('registers confluence command with subcommands', () => {
    const confluence = program.commands.find((c) => c.name() === 'confluence');
    expect(confluence).toBeDefined();
    const subcommands = confluence!.commands.map((c) => c.name());
    expect(subcommands).toContain('spaces');
    expect(subcommands).toContain('pages');
    expect(subcommands).toContain('import');
    expect(subcommands).toContain('import-space');
  });

  it('pages subcommand accepts a space-key argument', () => {
    const confluence = program.commands.find((c) => c.name() === 'confluence');
    const pages = confluence!.commands.find((c) => c.name() === 'pages');
    expect(pages).toBeDefined();
    const args = pages!.registeredArguments ?? [];
    expect(args.length).toBeGreaterThan(0);
    expect(args[0].name()).toBe('spaceKey');
  });

  it('import subcommand requires --team-id', () => {
    const confluence = program.commands.find((c) => c.name() === 'confluence');
    const importCmd = confluence!.commands.find((c) => c.name() === 'import');
    expect(importCmd).toBeDefined();
    const teamIdOption = importCmd!.options.find((o) => o.long === '--team-id');
    expect(teamIdOption).toBeDefined();
    expect(teamIdOption!.required).toBe(true);
  });

  it('import subcommand accepts a page-id argument', () => {
    const confluence = program.commands.find((c) => c.name() === 'confluence');
    const importCmd = confluence!.commands.find((c) => c.name() === 'import');
    expect(importCmd).toBeDefined();
    const args = importCmd!.registeredArguments ?? [];
    expect(args.length).toBeGreaterThan(0);
    expect(args[0].name()).toBe('pageId');
  });

  it('import-space subcommand requires --team-id', () => {
    const confluence = program.commands.find((c) => c.name() === 'confluence');
    const importSpace = confluence!.commands.find((c) => c.name() === 'import-space');
    expect(importSpace).toBeDefined();
    const teamIdOption = importSpace!.options.find((o) => o.long === '--team-id');
    expect(teamIdOption).toBeDefined();
    expect(teamIdOption!.required).toBe(true);
  });

  it('import-space subcommand accepts a space-key argument', () => {
    const confluence = program.commands.find((c) => c.name() === 'confluence');
    const importSpace = confluence!.commands.find((c) => c.name() === 'import-space');
    expect(importSpace).toBeDefined();
    const args = importSpace!.registeredArguments ?? [];
    expect(args.length).toBeGreaterThan(0);
    expect(args[0].name()).toBe('spaceKey');
  });

  it('all subcommands support --format option', () => {
    const confluence = program.commands.find((c) => c.name() === 'confluence');
    for (const sub of confluence!.commands) {
      const formatOpt = sub.options.find((o) => o.long === '--format');
      expect(formatOpt).toBeDefined();
    }
  });
});
