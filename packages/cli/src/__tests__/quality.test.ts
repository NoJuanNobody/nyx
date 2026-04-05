import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { registerQualityCommand } from '../commands/quality.js';
import { NyxClient } from '../client.js';

vi.mock('../client.js', () => ({
  NyxClient: vi.fn(),
  resolveTeamId: vi.fn().mockReturnValue('team-1'),
  resolveDocId: vi.fn().mockResolvedValue('doc-1'),
}));

describe('quality command', () => {
  let program: Command;
  let mockGet: ReturnType<typeof vi.fn>;
  let mockPost: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockGet = vi.fn();
    mockPost = vi.fn();
    vi.mocked(NyxClient).mockImplementation(() => ({
      get: mockGet,
      post: mockPost,
      put: vi.fn(),
      delete: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any));

    program = new Command();
    program.exitOverride();
    registerQualityCommand(program);
  });

  it('registers quality command with check subcommand', () => {
    const quality = program.commands.find((c) => c.name() === 'quality');
    expect(quality).toBeDefined();
    const subcommands = quality!.commands.map((c) => c.name());
    expect(subcommands).toContain('check');
  });

  it('fetches document and sends content to analyze endpoint', async () => {
    mockGet.mockResolvedValue({ content: 'My spec content' });
    mockPost.mockResolvedValue({ score: 8, suggestions: [] });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await program.parseAsync(['node', 'nyx', 'quality', 'check', 'doc-123']);

    expect(mockGet).toHaveBeenCalledWith('/api/documents/doc-123');
    expect(mockPost).toHaveBeenCalledWith('/api/ai/analyze', { content: 'My spec content' });
    consoleSpy.mockRestore();
  });

  it('passes stage option to analyze endpoint', async () => {
    mockGet.mockResolvedValue({ content: 'Spec content' });
    mockPost.mockResolvedValue({ score: 9, suggestions: [] });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await program.parseAsync(['node', 'nyx', 'quality', 'check', 'doc-123', '--stage', 'definition']);

    expect(mockPost).toHaveBeenCalledWith('/api/ai/analyze', {
      content: 'Spec content',
      stage: 'definition',
    });
    consoleSpy.mockRestore();
  });

  it('exits with code 1 when score is below threshold', async () => {
    mockGet.mockResolvedValue({ content: 'Bad spec' });
    mockPost.mockResolvedValue({ score: 3, suggestions: ['improve'] });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await program.parseAsync(['node', 'nyx', 'quality', 'check', 'doc-123', '--threshold', '5']);

    expect(exitSpy).toHaveBeenCalledWith(1);
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('does not exit with code 1 when score meets threshold', async () => {
    mockGet.mockResolvedValue({ content: 'Good spec' });
    mockPost.mockResolvedValue({ score: 8, suggestions: [] });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await program.parseAsync(['node', 'nyx', 'quality', 'check', 'doc-123', '--threshold', '7']);

    expect(exitSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('outputs in table format when --format table is used', async () => {
    mockGet.mockResolvedValue({ content: 'Spec' });
    mockPost.mockResolvedValue({ score: 8, quality: 'good' });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await program.parseAsync(['node', 'nyx', 'quality', 'check', 'doc-123', '--format', 'table']);

    const output = consoleSpy.mock.calls[0][0] as string;
    expect(output).toContain('Score');
    expect(output).toContain('8');
    consoleSpy.mockRestore();
  });
});
