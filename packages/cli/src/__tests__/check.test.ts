import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { registerCheckCommand } from '../commands/check.js';
import { NyxClient } from '../client.js';

vi.mock('../client.js', () => ({
  NyxClient: vi.fn(),
  resolveTeamId: vi.fn(() => 'team-abc'),
  resolveDocId: vi.fn().mockResolvedValue('doc-1'),
}));

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(() => 'function hello() { return 1; }'),
  existsSync: vi.fn(() => true),
}));

describe('check command', () => {
  let program: Command;
  let mockPost: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockPost = vi.fn();
    vi.mocked(NyxClient).mockImplementation(() => ({
      get: vi.fn(),
      post: mockPost,
      put: vi.fn(),
      delete: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any));

    program = new Command();
    program.exitOverride();
    registerCheckCommand(program);
  });

  it('registers check command', () => {
    const check = program.commands.find((c) => c.name() === 'check');
    expect(check).toBeDefined();
  });

  it('sends file content to compliance endpoint', async () => {
    mockPost.mockResolvedValue({ compliant: true, violations: [] });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await program.parseAsync(['node', 'nyx', 'check', 'src/app.ts']);

    expect(mockPost).toHaveBeenCalledWith('/api/compliance/check', {
      code: 'function hello() { return 1; }',
      teamId: 'team-abc',
      filePath: 'src/app.ts',
    });
    consoleSpy.mockRestore();
  });

  it('prints compliant message when no violations', async () => {
    mockPost.mockResolvedValue({ compliant: true, violations: [] });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await program.parseAsync(['node', 'nyx', 'check', 'src/app.ts']);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('Compliant');
    consoleSpy.mockRestore();
  });

  it('prints violations in pretty format', async () => {
    mockPost.mockResolvedValue({
      compliant: false,
      violations: [
        {
          rule: 'auth-required',
          severity: 'error',
          description: 'Missing auth check on route',
          specRef: 'Spec chunk 1',
        },
        {
          rule: 'naming-convention',
          severity: 'warning',
          description: 'Function name does not follow convention',
          specRef: 'Spec chunk 2',
        },
      ],
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await program.parseAsync(['node', 'nyx', 'check', 'src/app.ts']);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('1 error(s)');
    expect(output).toContain('1 warning(s)');
    expect(output).toContain('ERROR');
    expect(output).toContain('auth-required');
    expect(output).toContain('WARNING');
    expect(output).toContain('naming-convention');

    expect(exitSpy).toHaveBeenCalledWith(1);
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('exits with code 1 when errors are present', async () => {
    mockPost.mockResolvedValue({
      compliant: false,
      violations: [
        {
          rule: 'missing-validation',
          severity: 'error',
          description: 'Input is not validated',
          specRef: 'Spec chunk 1',
        },
      ],
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await program.parseAsync(['node', 'nyx', 'check', 'src/app.ts']);

    expect(exitSpy).toHaveBeenCalledWith(1);
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('does not exit with code 1 when only warnings', async () => {
    mockPost.mockResolvedValue({
      compliant: false,
      violations: [
        {
          rule: 'style-hint',
          severity: 'warning',
          description: 'Consider renaming',
          specRef: 'Spec chunk 1',
        },
      ],
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await program.parseAsync(['node', 'nyx', 'check', 'src/app.ts']);

    expect(exitSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('outputs JSON when --format json', async () => {
    const result = {
      compliant: false,
      violations: [
        {
          rule: 'test-rule',
          severity: 'error' as const,
          description: 'Test violation',
          specRef: 'Spec chunk 1',
        },
      ],
    };
    mockPost.mockResolvedValue(result);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await program.parseAsync(['node', 'nyx', 'check', 'src/app.ts', '--format', 'json']);

    const output = consoleSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.compliant).toBe(false);
    expect(parsed.violations).toHaveLength(1);
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
