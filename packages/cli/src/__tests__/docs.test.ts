import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { registerDocsCommand } from '../commands/docs.js';

// Mock the client module
vi.mock('../client.js', () => ({
  NyxClient: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockResolvedValue([{ id: '1', title: 'Test Doc', stage: 'definition' }]),
    post: vi.fn().mockResolvedValue({ id: '2', title: 'New Doc' }),
    put: vi.fn().mockResolvedValue({ id: '1', title: 'Updated Doc' }),
    delete: vi.fn().mockResolvedValue({ id: '1', status: 'archived' }),
  })),
}));

describe('docs command', () => {
  let program: Command;

  beforeEach(() => {
    vi.restoreAllMocks();
    // Re-mock after restore
    vi.mock('../client.js', () => ({
      NyxClient: vi.fn().mockImplementation(() => ({
        get: vi.fn().mockResolvedValue([{ id: '1', title: 'Test Doc', stage: 'definition' }]),
        post: vi.fn().mockResolvedValue({ id: '2', title: 'New Doc' }),
        put: vi.fn().mockResolvedValue({ id: '1', title: 'Updated Doc' }),
        delete: vi.fn().mockResolvedValue({ id: '1', status: 'archived' }),
      })),
    }));
    program = new Command();
    program.exitOverride(); // prevent process.exit in tests
    registerDocsCommand(program);
  });

  it('registers docs command with subcommands', () => {
    const docs = program.commands.find((c) => c.name() === 'docs');
    expect(docs).toBeDefined();
    const subcommands = docs!.commands.map((c) => c.name());
    expect(subcommands).toContain('list');
    expect(subcommands).toContain('read');
    expect(subcommands).toContain('create');
    expect(subcommands).toContain('update');
    expect(subcommands).toContain('delete');
  });
});
