import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import {
  registerOrchestrateCommand,
  expandTemplateDeps,
} from '../commands/orchestrate.js';

const mockGet = vi.fn();
const mockPost = vi.fn();

vi.mock('../client.js', () => ({
  NyxClient: vi.fn().mockImplementation(() => ({
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
  })),
  resolveTeamId: vi.fn().mockReturnValue('team-1'),
  resolveDocId: vi.fn().mockResolvedValue('doc-1'),
}));

describe('orchestrate command', () => {
  let program: Command;

  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    program = new Command();
    program.exitOverride();
    registerOrchestrateCommand(program);
  });

  it('registers orchestrate command with all subcommands', () => {
    const orchestrate = program.commands.find(
      (c) => c.name() === 'orchestrate',
    );
    expect(orchestrate).toBeDefined();
    const subcommands = orchestrate!.commands.map((c) => c.name());
    expect(subcommands).toContain('create');
    expect(subcommands).toContain('list');
    expect(subcommands).toContain('status');
    expect(subcommands).toContain('claim');
    expect(subcommands).toContain('complete');
    expect(subcommands).toContain('state');
    expect(subcommands).toContain('lock');
  });

  it('create requires --team-id, --doc-id, --name', () => {
    const orchestrate = program.commands.find(
      (c) => c.name() === 'orchestrate',
    );
    const create = orchestrate!.commands.find((c) => c.name() === 'create');
    expect(create).toBeDefined();
    const optionNames = create!.options.map((o) => o.long);
    expect(optionNames).toContain('--team-id');
    expect(optionNames).toContain('--doc-id');
    expect(optionNames).toContain('--name');
    expect(optionNames).toContain('--steps');
    expect(optionNames).toContain('--template');
    expect(optionNames).toContain('--format');
  });

  it('create with --steps posts to API', async () => {
    const pipeline = {
      id: 'pipe-1',
      name: 'Test Pipeline',
      status: 'pending',
      steps: [{ id: 'step-0', name: 'Review', workflowId: 'full_spec_review', status: 'pending', dependsOn: [] }],
    };
    mockPost.mockResolvedValue(pipeline);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stepsJson = JSON.stringify([{ name: 'Review', workflowId: 'full_spec_review' }]);

    await program.parseAsync([
      'node', 'nyx', 'orchestrate', 'create',
      '--team-id', 'team-1',
      '--doc-id', 'doc-1',
      '--name', 'Test Pipeline',
      '--steps', stepsJson,
    ]);

    expect(mockPost).toHaveBeenCalledWith('/api/orchestration/pipelines', {
      teamId: 'team-1',
      documentId: 'doc-1',
      name: 'Test Pipeline',
      steps: [{ name: 'Review', workflowId: 'full_spec_review' }],
    });
    const output = JSON.parse(log.mock.calls[0][0] as string);
    expect(output.id).toBe('pipe-1');
    log.mockRestore();
  });

  it('create with --template review-and-fix expands template steps', async () => {
    const pipeline = {
      id: 'pipe-2',
      name: 'Review Pipeline',
      status: 'pending',
      steps: [
        { id: 'step-0', name: 'Spec Review', workflowId: 'full_spec_review', status: 'pending', dependsOn: [] },
        { id: 'step-1', name: 'Impact Analysis', workflowId: 'change_impact_analysis', status: 'pending', dependsOn: [] },
        { id: 'step-2', name: 'Doc Generation', workflowId: 'doc_generation', status: 'pending', dependsOn: [] },
      ],
    };
    mockPost.mockResolvedValue(pipeline);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync([
      'node', 'nyx', 'orchestrate', 'create',
      '--team-id', 'team-1',
      '--doc-id', 'doc-1',
      '--name', 'Review Pipeline',
      '--template', 'review-and-fix',
    ]);

    expect(mockPost).toHaveBeenCalledWith('/api/orchestration/pipelines', {
      teamId: 'team-1',
      documentId: 'doc-1',
      name: 'Review Pipeline',
      steps: [
        { name: 'Spec Review', workflowId: 'full_spec_review' },
        { name: 'Impact Analysis', workflowId: 'change_impact_analysis' },
        { name: 'Doc Generation', workflowId: 'doc_generation' },
      ],
    });

    const output = JSON.parse(log.mock.calls[0][0] as string);
    // After template expansion, step-1 depends on step-0, step-2 depends on step-1
    expect(output.steps[1].dependsOn).toEqual(['step-0']);
    expect(output.steps[2].dependsOn).toEqual(['step-1']);
    log.mockRestore();
  });

  it('create with --template full-audit expands template steps', async () => {
    const pipeline = {
      id: 'pipe-3',
      name: 'Audit Pipeline',
      status: 'pending',
      steps: [
        { id: 'step-0', name: 'Sync Check', workflowId: 'codebase_sync_check', status: 'pending', dependsOn: [] },
        { id: 'step-1', name: 'Spec Review', workflowId: 'full_spec_review', status: 'pending', dependsOn: [] },
        { id: 'step-2', name: 'Impact Analysis', workflowId: 'change_impact_analysis', status: 'pending', dependsOn: [] },
      ],
    };
    mockPost.mockResolvedValue(pipeline);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync([
      'node', 'nyx', 'orchestrate', 'create',
      '--team-id', 'team-1',
      '--doc-id', 'doc-1',
      '--name', 'Audit Pipeline',
      '--template', 'full-audit',
    ]);

    const output = JSON.parse(log.mock.calls[0][0] as string);
    expect(output.steps[2].dependsOn).toEqual(['step-0', 'step-1']);
    log.mockRestore();
  });

  it('list calls GET with teamId', async () => {
    const pipelines = [
      { id: 'pipe-1', name: 'Pipeline A', status: 'active' },
      { id: 'pipe-2', name: 'Pipeline B', status: 'completed' },
    ];
    mockGet.mockResolvedValue(pipelines);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await program.parseAsync([
      'node', 'nyx', 'orchestrate', 'list',
      '--team-id', 'team-1',
      '--format', 'json',
    ]);

    expect(mockGet).toHaveBeenCalledWith(
      '/api/orchestration/pipelines?teamId=team-1',
    );
    const output = JSON.parse(log.mock.calls[0][0] as string);
    expect(output).toHaveLength(2);
    log.mockRestore();
  });

  it('status calls GET /api/orchestration/pipelines/:id', async () => {
    const pipeline = {
      id: 'pipe-1',
      name: 'Pipeline A',
      status: 'active',
      steps: [
        { id: 'step-0', name: 'Review', status: 'completed', dependsOn: [] },
        { id: 'step-1', name: 'Generate', status: 'pending', dependsOn: ['step-0'] },
      ],
    };
    mockGet.mockResolvedValue(pipeline);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await program.parseAsync([
      'node', 'nyx', 'orchestrate', 'status', 'pipe-1',
    ]);

    expect(mockGet).toHaveBeenCalledWith(
      '/api/orchestration/pipelines/pipe-1',
    );
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it('status with --format table shows dependency arrows', async () => {
    const pipeline = {
      id: 'pipe-1',
      name: 'Pipeline A',
      status: 'active',
      steps: [
        { id: 'step-0', name: 'Review', status: 'completed', dependsOn: [] },
        { id: 'step-1', name: 'Generate', status: 'pending', dependsOn: ['step-0'] },
      ],
    };
    mockGet.mockResolvedValue(pipeline);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await program.parseAsync([
      'node', 'nyx', 'orchestrate', 'status', 'pipe-1',
      '--format', 'table',
    ]);

    const output = log.mock.calls[0][0] as string;
    expect(output).toContain('Pipeline: Pipeline A');
    expect(output).toContain('[completed] Review');
    expect(output).toContain('[pending] Generate');
    expect(output).toContain('<- [step-0]');
    log.mockRestore();
  });

  it('claim posts to the correct endpoint', async () => {
    const result = { id: 'step-0', status: 'in_progress', claimedBy: 'sess-1' };
    mockPost.mockResolvedValue(result);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await program.parseAsync([
      'node', 'nyx', 'orchestrate', 'claim', 'pipe-1', 'step-0',
      '--session-id', 'sess-1',
    ]);

    expect(mockPost).toHaveBeenCalledWith(
      '/api/orchestration/pipelines/pipe-1/steps/step-0/claim',
      { sessionId: 'sess-1' },
    );
    log.mockRestore();
  });

  it('complete posts to the correct endpoint', async () => {
    const result = { id: 'step-0', status: 'completed' };
    mockPost.mockResolvedValue(result);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await program.parseAsync([
      'node', 'nyx', 'orchestrate', 'complete', 'pipe-1', 'step-0',
      '--session-id', 'sess-1',
    ]);

    expect(mockPost).toHaveBeenCalledWith(
      '/api/orchestration/pipelines/pipe-1/steps/step-0/complete',
      { sessionId: 'sess-1' },
    );
    log.mockRestore();
  });

  it('state calls GET /api/orchestration/pipelines/:id/state', async () => {
    const state = { context: { key: 'value' }, lastUpdated: '2026-03-15' };
    mockGet.mockResolvedValue(state);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await program.parseAsync([
      'node', 'nyx', 'orchestrate', 'state', 'pipe-1',
    ]);

    expect(mockGet).toHaveBeenCalledWith(
      '/api/orchestration/pipelines/pipe-1/state',
    );
    const output = JSON.parse(log.mock.calls[0][0] as string);
    expect(output.context.key).toBe('value');
    log.mockRestore();
  });

  it('lock calls GET /api/orchestration/locks/:docId', async () => {
    const lock = { documentId: 'doc-1', locked: true, lockedBy: 'sess-1' };
    mockGet.mockResolvedValue(lock);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await program.parseAsync([
      'node', 'nyx', 'orchestrate', 'lock', 'doc-1',
    ]);

    expect(mockGet).toHaveBeenCalledWith('/api/orchestration/locks/doc-1');
    const output = JSON.parse(log.mock.calls[0][0] as string);
    expect(output.locked).toBe(true);
    log.mockRestore();
  });
});

describe('expandTemplateDeps', () => {
  it('replaces $N placeholders with actual step IDs', () => {
    const steps = [
      { id: 'abc', name: 'A', workflowId: 'w1', status: 'pending', dependsOn: [] },
      { id: 'def', name: 'B', workflowId: 'w2', status: 'pending', dependsOn: [] },
      { id: 'ghi', name: 'C', workflowId: 'w3', status: 'pending', dependsOn: [] },
    ];
    const template = [
      { name: 'A', workflowId: 'w1' },
      { name: 'B', workflowId: 'w2', dependsOn: ['$0'] },
      { name: 'C', workflowId: 'w3', dependsOn: ['$0', '$1'] },
    ];

    expandTemplateDeps(steps, template);

    expect(steps[0].dependsOn).toEqual([]);
    expect(steps[1].dependsOn).toEqual(['abc']);
    expect(steps[2].dependsOn).toEqual(['abc', 'def']);
  });

  it('preserves non-placeholder references', () => {
    const steps = [
      { id: 'abc', name: 'A', workflowId: 'w1', status: 'pending', dependsOn: [] },
      { id: 'def', name: 'B', workflowId: 'w2', status: 'pending', dependsOn: [] },
    ];
    const template = [
      { name: 'A', workflowId: 'w1' },
      { name: 'B', workflowId: 'w2', dependsOn: ['$0', 'external-id'] },
    ];

    expandTemplateDeps(steps, template);

    expect(steps[1].dependsOn).toEqual(['abc', 'external-id']);
  });

  it('handles empty steps array', () => {
    const steps: { id: string; name: string; workflowId: string; status: string; dependsOn: string[] }[] = [];
    const template: { name: string; workflowId: string; dependsOn?: string[] }[] = [];

    expandTemplateDeps(steps, template);

    expect(steps).toEqual([]);
  });
});
