import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

// Mock the api-client module
vi.mock('../lib/api-client.js', () => ({
  apiGet: vi.fn(),
}));

import { registerWatchCommand, registerChangesCommand } from '../commands/watch.js';
import { apiGet } from '../lib/api-client.js';

const mockApiGet = vi.mocked(apiGet);

describe('watch command', () => {
  it('registers the watch command', () => {
    const program = new Command();
    registerWatchCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'watch');
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toMatch(/poll/i);
  });

  it('watch command requires --team-id', () => {
    const program = new Command();
    program.exitOverride();
    registerWatchCommand(program);
    const cmd = program.commands.find((c) => c.name() === 'watch');
    expect(cmd).toBeDefined();
    // The requiredOption should be present
    const teamIdOpt = cmd!.options.find((o) => o.long === '--team-id');
    expect(teamIdOpt).toBeDefined();
    expect(teamIdOpt!.required).toBe(true);
  });
});

describe('changes command', () => {
  let program: Command;
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride();
    registerChangesCommand(program);
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('registers the changes command', () => {
    const cmd = program.commands.find((c) => c.name() === 'changes');
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toMatch(/change/i);
  });

  it('fetches and displays changes in table format', async () => {
    const mockData = {
      changes: [
        {
          id: 'doc-1',
          title: 'API Auth Guide',
          updatedAt: '2026-03-15T10:00:00.000Z',
          status: 'published',
          stage: 'implementation',
        },
      ],
      since: '2026-03-14T00:00:00.000Z',
      until: '2026-03-15T10:00:00.000Z',
    };

    mockApiGet.mockResolvedValueOnce(mockData);

    await program.parseAsync([
      'node', 'nyx', 'changes',
      '--team-id', 'team-1',
      '--since', '2026-03-14T00:00:00Z',
    ]);

    expect(mockApiGet).toHaveBeenCalledWith('/api/documents/changes', {
      teamId: 'team-1',
      since: '2026-03-14T00:00:00Z',
      limit: '50',
    });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('1 change(s)'));
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('API Auth Guide'),
    );
  });

  it('outputs JSON when --format json is used', async () => {
    const mockData = {
      changes: [
        {
          id: 'doc-1',
          title: 'Test Doc',
          updatedAt: '2026-03-15T10:00:00.000Z',
          status: 'draft',
          stage: null,
        },
      ],
      since: '2026-03-14T00:00:00.000Z',
      until: '2026-03-15T10:00:00.000Z',
    };

    mockApiGet.mockResolvedValueOnce(mockData);

    await program.parseAsync([
      'node', 'nyx', 'changes',
      '--team-id', 'team-1',
      '--since', '2026-03-14T00:00:00Z',
      '--format', 'json',
    ]);

    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(mockData, null, 2));
  });

  it('shows message when no changes found', async () => {
    mockApiGet.mockResolvedValueOnce({
      changes: [],
      since: '2026-03-14T00:00:00.000Z',
      until: '2026-03-14T00:00:00.000Z',
    });

    await program.parseAsync([
      'node', 'nyx', 'changes',
      '--team-id', 'team-1',
      '--since', '2026-03-14T00:00:00Z',
    ]);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('No changes found'),
      expect.any(String),
    );
  });

  it('respects --limit parameter', async () => {
    mockApiGet.mockResolvedValueOnce({ changes: [], since: '', until: '' });

    await program.parseAsync([
      'node', 'nyx', 'changes',
      '--team-id', 'team-1',
      '--since', '2026-03-14T00:00:00Z',
      '--limit', '10',
    ]);

    expect(mockApiGet).toHaveBeenCalledWith('/api/documents/changes', expect.objectContaining({
      limit: '10',
    }));
  });
});
