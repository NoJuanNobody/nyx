import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { registerPodcastCommand } from '../commands/podcast.js';

// Mock the api module
vi.mock('../lib/api.js', () => ({
  apiRequest: vi.fn(),
  getBaseUrl: vi.fn(() => 'http://localhost:3001'),
}));

import { apiRequest } from '../lib/api.js';

const mockApiRequest = vi.mocked(apiRequest);

const mockScript = {
  id: 'podcast-1',
  teamId: 'team-1',
  title: 'Test Episode',
  documentIds: ['doc-1', 'doc-2'],
  script: [
    { speaker: 'Host A' as const, text: 'Welcome!' },
    { speaker: 'Host B' as const, text: 'Thanks for having me.' },
  ],
  qualityScore: 8,
  suggestions: ['Add more detail'],
  createdAt: '2026-03-15T00:00:00.000Z',
};

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride(); // Throw instead of process.exit
  registerPodcastCommand(program);
  return program;
}

describe('Podcast CLI Command', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  describe('podcast generate', () => {
    it('calls the API and prints script output', async () => {
      mockApiRequest.mockResolvedValue(mockScript);

      const program = buildProgram();
      await program.parseAsync([
        'node', 'nyx',
        'podcast', 'generate', 'doc-1', 'doc-2',
        '--team-id', 'team-1',
        '--title', 'Test Episode',
      ]);

      expect(mockApiRequest).toHaveBeenCalledWith(
        '/api/podcast/generate',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            documentIds: ['doc-1', 'doc-2'],
            teamId: 'team-1',
            title: 'Test Episode',
          }),
        }),
      );

      expect(consoleSpy).toHaveBeenCalled();
      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('Test Episode');
      expect(output).toContain('[Host A]');
    });

    it('supports JSON format', async () => {
      mockApiRequest.mockResolvedValue(mockScript);

      const program = buildProgram();
      await program.parseAsync([
        'node', 'nyx',
        'podcast', 'generate', 'doc-1',
        '--team-id', 'team-1',
        '--format', 'json',
      ]);

      expect(consoleSpy).toHaveBeenCalled();
      const output = consoleSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(parsed.id).toBe('podcast-1');
    });

    it('handles API errors gracefully', async () => {
      mockApiRequest.mockRejectedValue(new Error('Network error'));

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

      const program = buildProgram();
      // Need a fresh program without exitOverride for this test
      const rawProgram = new Command();
      registerPodcastCommand(rawProgram);

      await rawProgram.parseAsync([
        'node', 'nyx',
        'podcast', 'generate', 'doc-1',
        '--team-id', 'team-1',
      ]);

      expect(errorSpy).toHaveBeenCalledWith('Error:', 'Network error');
      exitSpy.mockRestore();
    });
  });

  describe('podcast list', () => {
    it('calls the API and prints a table', async () => {
      mockApiRequest.mockResolvedValue({ scripts: [mockScript] });

      const program = buildProgram();
      await program.parseAsync([
        'node', 'nyx',
        'podcast', 'list',
        '--team-id', 'team-1',
      ]);

      expect(mockApiRequest).toHaveBeenCalledWith(
        '/api/podcast/scripts?teamId=team-1',
      );

      expect(consoleSpy).toHaveBeenCalled();
      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('podcast-1');
      expect(output).toContain('Test Episode');
    });

    it('supports JSON format', async () => {
      mockApiRequest.mockResolvedValue({ scripts: [mockScript] });

      const program = buildProgram();
      await program.parseAsync([
        'node', 'nyx',
        'podcast', 'list',
        '--team-id', 'team-1',
        '--format', 'json',
      ]);

      expect(consoleSpy).toHaveBeenCalled();
      const output = consoleSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].id).toBe('podcast-1');
    });

    it('shows message when no scripts found', async () => {
      mockApiRequest.mockResolvedValue({ scripts: [] });

      const program = buildProgram();
      await program.parseAsync([
        'node', 'nyx',
        'podcast', 'list',
        '--team-id', 'team-1',
      ]);

      expect(consoleSpy).toHaveBeenCalled();
      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('(no results)');
    });
  });
});
