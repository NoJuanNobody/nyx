import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { registerBulkCommand } from '../commands/bulk.js';

const mockGet = vi.fn();
const mockPut = vi.fn();
const mockPost = vi.fn();
const mockGetRaw = vi.fn();

vi.mock('../client.js', () => ({
  NyxClient: vi.fn().mockImplementation(() => ({
    get: mockGet,
    put: mockPut,
    post: mockPost,
    getRaw: mockGetRaw,
  })),
  resolveTeamId: vi.fn().mockReturnValue('team-1'),
  resolveDocId: vi.fn().mockResolvedValue('doc-1'),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

describe('bulk command', () => {
  let program: Command;

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride();
    registerBulkCommand(program);
  });

  it('registers bulk command with subcommands', () => {
    const bulk = program.commands.find((c) => c.name() === 'bulk');
    expect(bulk).toBeDefined();
    const subcommands = bulk!.commands.map((c) => c.name());
    expect(subcommands).toContain('export');
    expect(subcommands).toContain('sync');
  });

  describe('bulk export', () => {
    it('exports documents as markdown by default', async () => {
      const docs = [
        { id: '1', title: 'Doc One', stage: 'definition' },
        { id: '2', title: 'Doc Two', stage: 'build' },
      ];
      mockGet.mockResolvedValue(docs);
      mockGetRaw.mockResolvedValue({
        text: vi.fn().mockResolvedValue('# Markdown content'),
        arrayBuffer: vi.fn(),
      });

      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      await program.parseAsync([
        'node', 'test', 'bulk', 'export', '--team-id', 'team-1',
      ]);

      expect(mockGet).toHaveBeenCalledWith('/api/documents?teamId=team-1');
      expect(mockGetRaw).toHaveBeenCalledTimes(2);
      expect(mockGetRaw).toHaveBeenCalledWith('/api/export/documents/1/export/markdown');
      expect(mockGetRaw).toHaveBeenCalledWith('/api/export/documents/2/export/markdown');
      expect(log).toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledWith('Exported 2 document(s).\n');

      log.mockRestore();
      stderr.mockRestore();
    });

    it('filters by stage when --stage is provided', async () => {
      mockGet.mockResolvedValue([]);
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      await program.parseAsync([
        'node', 'test', 'bulk', 'export', '--team-id', 'team-1', '--stage', 'build',
      ]);

      expect(mockGet).toHaveBeenCalledWith('/api/documents?teamId=team-1&stage=build');
      log.mockRestore();
      stderr.mockRestore();
    });

    it('exports as pdf when --export-format pdf is set', async () => {
      const docs = [{ id: '1', title: 'Doc One' }];
      mockGet.mockResolvedValue(docs);
      const pdfBuffer = new ArrayBuffer(4);
      mockGetRaw.mockResolvedValue({
        text: vi.fn(),
        arrayBuffer: vi.fn().mockResolvedValue(pdfBuffer),
      });

      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      await program.parseAsync([
        'node', 'test', 'bulk', 'export', '--team-id', 'team-1', '--export-format', 'pdf',
      ]);

      expect(mockGetRaw).toHaveBeenCalledWith('/api/export/documents/1/export/pdf');
      log.mockRestore();
      stderr.mockRestore();
    });

    it('handles empty document list', async () => {
      mockGet.mockResolvedValue([]);
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      await program.parseAsync([
        'node', 'test', 'bulk', 'export', '--team-id', 'team-1',
      ]);

      expect(mockGetRaw).not.toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledWith('No documents found.\n');
      log.mockRestore();
      stderr.mockRestore();
    });
  });

  describe('bulk sync', () => {
    it('calls sync-all endpoint and prints result', async () => {
      const syncResult = { synced: 5, errors: 0 };
      mockPost.mockResolvedValue(syncResult);

      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      await program.parseAsync([
        'node', 'test', 'bulk', 'sync', '--team-id', 'team-1',
      ]);

      expect(mockPost).toHaveBeenCalledWith('/api/tickets/sync-all?teamId=team-1');
      expect(stderr).toHaveBeenCalledWith('Ticket sync complete.\n');
      expect(log).toHaveBeenCalled();
      const output = JSON.parse(log.mock.calls[0][0] as string);
      expect(output).toEqual(syncResult);

      log.mockRestore();
      stderr.mockRestore();
    });
  });
});
