import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { registerVersionsCommand, registerDiffCommand } from '../commands/versions.js';

vi.mock('../client.js', () => ({
  NyxClient: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockResolvedValue([
      { id: 'v1', documentId: 'doc-1', version: 1, createdAt: '2025-01-01' },
      { id: 'v2', documentId: 'doc-1', version: 2, createdAt: '2025-01-02' },
    ]),
  })),
}));

describe('versions command', () => {
  let program: Command;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mock('../client.js', () => ({
      NyxClient: vi.fn().mockImplementation(() => ({
        get: vi.fn().mockResolvedValue([
          { id: 'v1', documentId: 'doc-1', version: 1, createdAt: '2025-01-01' },
          { id: 'v2', documentId: 'doc-1', version: 2, createdAt: '2025-01-02' },
        ]),
      })),
    }));
    program = new Command();
    program.exitOverride();
    registerVersionsCommand(program);
  });

  it('registers versions as a top-level command', () => {
    const cmd = program.commands.find((c) => c.name() === 'versions');
    expect(cmd).toBeDefined();
  });

  it('accepts a doc-id argument', () => {
    const cmd = program.commands.find((c) => c.name() === 'versions');
    const args = cmd!.registeredArguments ?? [];
    expect(args.length).toBe(1);
    expect(args[0].name()).toBe('doc-id');
  });

  it('supports --format option', () => {
    const cmd = program.commands.find((c) => c.name() === 'versions');
    const formatOpt = cmd!.options.find((o) => o.long === '--format');
    expect(formatOpt).toBeDefined();
  });
});

describe('diff command', () => {
  let program: Command;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mock('../client.js', () => ({
      NyxClient: vi.fn().mockImplementation(() => ({
        get: vi.fn().mockResolvedValue({
          versionA: 'v1',
          versionB: 'v2',
          changes: [{ path: '/title', op: 'replace', oldValue: 'Old', newValue: 'New' }],
        }),
      })),
    }));
    program = new Command();
    program.exitOverride();
    registerDiffCommand(program);
  });

  it('registers diff as a top-level command', () => {
    const cmd = program.commands.find((c) => c.name() === 'diff');
    expect(cmd).toBeDefined();
  });

  it('accepts version-a and version-b arguments', () => {
    const cmd = program.commands.find((c) => c.name() === 'diff');
    const args = cmd!.registeredArguments ?? [];
    expect(args.length).toBe(2);
    expect(args[0].name()).toBe('version-a');
    expect(args[1].name()).toBe('version-b');
  });

  it('supports --format option', () => {
    const cmd = program.commands.find((c) => c.name() === 'diff');
    const formatOpt = cmd!.options.find((o) => o.long === '--format');
    expect(formatOpt).toBeDefined();
  });
});
