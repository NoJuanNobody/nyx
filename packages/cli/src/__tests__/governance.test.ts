import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import fs from 'node:fs';
import { registerGovernanceCommand } from '../commands/governance.js';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Capture console output
let consoleOutput: string[] = [];
let consoleErrors: string[] = [];

// Track process.exit calls
let exitCode: number | undefined;

describe('Governance CLI Commands', () => {
  let program: Command;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleOutput = [];
    consoleErrors = [];
    exitCode = undefined;
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      consoleOutput.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(' '));
    });
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCode = code;
    }) as never);

    program = new Command();
    program.exitOverride();
    registerGovernanceCommand(program);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('governance validate', () => {
    it('calls the API and shows allowed result', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            allowed: true,
            violations: [],
            warnings: ['Check scope'],
          }),
      });

      await program.parseAsync([
        'node',
        'nyx',
        'governance',
        'validate',
        '--action',
        'edit',
        '--team-id',
        'team-1',
        '--format',
        'json',
      ]);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain('/api/governance/validate');
      expect(opts.method).toBe('POST');
      const body = JSON.parse(opts.body);
      expect(body.action).toBe('edit');
      expect(body.teamId).toBe('team-1');
      expect(consoleOutput.join('')).toContain('"allowed": true');
      expect(exitCode).toBeUndefined();
    });

    it('exits with code 1 when action is not allowed', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            allowed: false,
            violations: ['Quality too low'],
            warnings: [],
          }),
      });

      await program.parseAsync([
        'node',
        'nyx',
        'governance',
        'validate',
        '--action',
        'publish',
        '--team-id',
        'team-1',
        '--format',
        'json',
      ]);

      expect(exitCode).toBe(1);
    });

    it('passes optional parameters', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ allowed: true, violations: [], warnings: [] }),
      });

      await program.parseAsync([
        'node',
        'nyx',
        'governance',
        'validate',
        '--action',
        'publish',
        '--team-id',
        'team-1',
        '--doc-id',
        'doc-1',
        '--content',
        'test content',
        '--stage',
        'definition',
        '--format',
        'json',
      ]);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.documentId).toBe('doc-1');
      expect(body.content).toBe('test content');
      expect(body.stage).toBe('definition');
    });

    it('displays table format by default', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            allowed: false,
            violations: ['Score too low'],
            warnings: ['Check format'],
          }),
      });

      await program.parseAsync([
        'node',
        'nyx',
        'governance',
        'validate',
        '--action',
        'publish',
        '--team-id',
        'team-1',
      ]);

      const output = consoleOutput.join('\n');
      expect(output).toContain('Allowed: NO');
      expect(output).toContain('Violations:');
      expect(output).toContain('Score too low');
      expect(output).toContain('Warnings:');
      expect(output).toContain('Check format');
      expect(exitCode).toBe(1);
    });

    it('handles API errors gracefully', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      await program.parseAsync([
        'node',
        'nyx',
        'governance',
        'validate',
        '--action',
        'edit',
        '--team-id',
        'team-1',
      ]);

      expect(exitCode).toBe(1);
      expect(consoleErrors.join('')).toContain('API request failed');
    });
  });

  describe('governance rules', () => {
    it('fetches and displays rules', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            constitution: { principles: [] },
            governance: { forbidden_paths: [] },
          }),
      });

      await program.parseAsync([
        'node',
        'nyx',
        'governance',
        'rules',
        '--format',
        'json',
      ]);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('/api/governance/rules');
      expect(consoleOutput.join('')).toContain('constitution');
      expect(exitCode).toBeUndefined();
    });
  });

  describe('governance check-file', () => {
    it('detects secrets in a file', async () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'readFileSync').mockReturnValue(
        'const key = "sk-live-abc123def456ghi789jkl012mno345pqr";\n',
      );

      await program.parseAsync([
        'node',
        'nyx',
        'governance',
        'check-file',
        'test-file.ts',
        '--format',
        'json',
      ]);

      expect(exitCode).toBe(1);
      const output = consoleOutput.join('');
      expect(output).toContain('"allowed": false');
    });

    it('passes for clean files', async () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'readFileSync').mockReturnValue(
        'const greeting = "Hello, world!";\n',
      );

      await program.parseAsync([
        'node',
        'nyx',
        'governance',
        'check-file',
        'clean-file.ts',
        '--format',
        'json',
      ]);

      const output = consoleOutput.join('');
      expect(output).toContain('"allowed": true');
      expect(exitCode).toBeUndefined();
    });

    it('errors when file does not exist', async () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);

      await program.parseAsync([
        'node',
        'nyx',
        'governance',
        'check-file',
        'nonexistent.ts',
      ]);

      expect(exitCode).toBe(1);
      expect(consoleErrors.join('')).toContain('File not found');
    });
  });
});
