import { Command } from 'commander';
import { NyxClient } from '../client.js';
import { formatOutput, error, type OutputFormat } from '../utils/output.js';

interface PipelineStep {
  name: string;
  workflowId: string;
  dependsOn?: string[];
}

interface CreatedStep {
  id: string;
  name: string;
  workflowId: string;
  status: string;
  dependsOn: string[];
  [key: string]: unknown;
}

interface Pipeline {
  id: string;
  name: string;
  status: string;
  steps: CreatedStep[];
  [key: string]: unknown;
}

const TEMPLATES: Record<string, PipelineStep[]> = {
  'review-and-fix': [
    { name: 'Spec Review', workflowId: 'full_spec_review' },
    {
      name: 'Impact Analysis',
      workflowId: 'change_impact_analysis',
      dependsOn: ['$0'],
    },
    {
      name: 'Doc Generation',
      workflowId: 'doc_generation',
      dependsOn: ['$1'],
    },
  ],
  'full-audit': [
    { name: 'Sync Check', workflowId: 'codebase_sync_check' },
    { name: 'Spec Review', workflowId: 'full_spec_review' },
    {
      name: 'Impact Analysis',
      workflowId: 'change_impact_analysis',
      dependsOn: ['$0', '$1'],
    },
  ],
};

export function expandTemplateDeps(
  steps: CreatedStep[],
  templateSteps: PipelineStep[],
): void {
  for (let i = 0; i < steps.length; i++) {
    const template = templateSteps[i];
    if (!template?.dependsOn) continue;

    steps[i].dependsOn = template.dependsOn.map((ref) => {
      const match = /^\$(\d+)$/.exec(ref);
      if (match) {
        const idx = parseInt(match[1], 10);
        if (idx < steps.length) {
          return steps[idx].id;
        }
      }
      return ref;
    });
  }
}

function formatStatus(pipeline: Pipeline): string {
  const lines: string[] = [];
  lines.push(`Pipeline: ${pipeline.name} (${pipeline.id})`);
  lines.push(`Status:   ${pipeline.status}`);
  lines.push('');
  lines.push('Steps:');

  for (const step of pipeline.steps) {
    const deps =
      step.dependsOn && step.dependsOn.length > 0
        ? ` <- [${step.dependsOn.join(', ')}]`
        : '';
    lines.push(`  [${step.status}] ${step.name} (${step.id})${deps}`);
  }

  return lines.join('\n');
}

export function registerOrchestrateCommand(program: Command): void {
  const orchestrate = program
    .command('orchestrate')
    .description('Multi-agent orchestration pipelines');

  orchestrate
    .command('create')
    .description('Create an orchestration pipeline')
    .requiredOption('--team-id <teamId>', 'Team ID')
    .requiredOption('--doc-id <docId>', 'Document ID')
    .requiredOption('--name <name>', 'Pipeline name')
    .option('--steps <json>', 'Steps as JSON array')
    .option(
      '--template <template>',
      'Use a predefined template (review-and-fix|full-audit)',
    )
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(
      async (opts: {
        teamId: string;
        docId: string;
        name: string;
        steps?: string;
        template?: string;
        format: OutputFormat;
      }) => {
        const client = new NyxClient();

        let steps: PipelineStep[];
        let templateSteps: PipelineStep[] | undefined;

        if (opts.template) {
          templateSteps = TEMPLATES[opts.template];
          if (!templateSteps) {
            error(
              `Unknown template "${opts.template}". Available: ${Object.keys(TEMPLATES).join(', ')}`,
            );
          }
          steps = templateSteps.map((s) => ({
            name: s.name,
            workflowId: s.workflowId,
          }));
        } else if (opts.steps) {
          try {
            steps = JSON.parse(opts.steps) as PipelineStep[];
          } catch {
            error('Invalid JSON for --steps');
          }
        } else {
          error('Provide --steps <json> or --template <name>');
        }

        try {
          const data = await client.post<Pipeline>(
            '/api/orchestration/pipelines',
            {
              teamId: opts.teamId,
              documentId: opts.docId,
              name: opts.name,
              steps,
            },
          );

          if (templateSteps && data.steps) {
            expandTemplateDeps(data.steps, templateSteps);
          }

          console.log(formatOutput(data, opts.format));
        } catch (err) {
          error(err instanceof Error ? err.message : String(err));
        }
      },
    );

  orchestrate
    .command('list')
    .description('List orchestration pipelines for a team')
    .requiredOption('--team-id <teamId>', 'Team ID')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (opts: { teamId: string; format: OutputFormat }) => {
      const client = new NyxClient();
      try {
        const data = await client.get(
          `/api/orchestration/pipelines?teamId=${opts.teamId}`,
        );
        console.log(formatOutput(data, opts.format));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  orchestrate
    .command('status <pipelineId>')
    .description('Show pipeline status with dependency arrows')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (pipelineId: string, opts: { format: OutputFormat }) => {
      const client = new NyxClient();
      try {
        const data = await client.get<Pipeline>(
          `/api/orchestration/pipelines/${pipelineId}`,
        );
        if (opts.format === 'json') {
          console.log(formatOutput(data, 'json'));
        } else {
          console.log(formatStatus(data));
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  orchestrate
    .command('claim <pipelineId> <stepId>')
    .description('Claim a pipeline step for processing')
    .requiredOption('--session-id <sessionId>', 'Agent session ID')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(
      async (
        pipelineId: string,
        stepId: string,
        opts: { sessionId: string; format: OutputFormat },
      ) => {
        const client = new NyxClient();
        try {
          const data = await client.post(
            `/api/orchestration/pipelines/${pipelineId}/steps/${stepId}/claim`,
            { sessionId: opts.sessionId },
          );
          console.log(formatOutput(data, opts.format));
        } catch (err) {
          error(err instanceof Error ? err.message : String(err));
        }
      },
    );

  orchestrate
    .command('complete <pipelineId> <stepId>')
    .description('Mark a pipeline step as complete')
    .requiredOption('--session-id <sessionId>', 'Agent session ID')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(
      async (
        pipelineId: string,
        stepId: string,
        opts: { sessionId: string; format: OutputFormat },
      ) => {
        const client = new NyxClient();
        try {
          const data = await client.post(
            `/api/orchestration/pipelines/${pipelineId}/steps/${stepId}/complete`,
            { sessionId: opts.sessionId },
          );
          console.log(formatOutput(data, opts.format));
        } catch (err) {
          error(err instanceof Error ? err.message : String(err));
        }
      },
    );

  orchestrate
    .command('state <pipelineId>')
    .description('Get shared state for a pipeline')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (pipelineId: string, opts: { format: OutputFormat }) => {
      const client = new NyxClient();
      try {
        const data = await client.get(
          `/api/orchestration/pipelines/${pipelineId}/state`,
        );
        console.log(formatOutput(data, opts.format));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  orchestrate
    .command('lock <docId>')
    .description('Check document lock status')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (docId: string, opts: { format: OutputFormat }) => {
      const client = new NyxClient();
      try {
        const data = await client.get(`/api/orchestration/locks/${docId}`);
        console.log(formatOutput(data, opts.format));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });
}
