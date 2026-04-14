import { Command } from 'commander';
import { NyxClient, resolveTeamId } from '../client.js';
import { formatOutput, formatTable, timeAgo, error, type OutputFormat } from '../utils/output.js';

interface Template {
  id: string;
  name: string;
  description: string;
  content: string;
  stage: string;
  teamId: string;
  createdAt: string;
  [key: string]: unknown;
}

export function registerTemplatesCommand(program: Command): void {
  const templates = program.command('templates').description('Manage document templates');

  templates
    .command('list')
    .description('List templates for your team')
    .option('--team-id <teamId>', 'Team ID')
    .option('--format <format>', 'Output format (json|table)', 'table')
    .action(async (opts: { teamId?: string; format: OutputFormat }) => {
      const teamId = resolveTeamId(opts.teamId);
      const client = new NyxClient();

      try {
        const data = await client.get<Template[]>(`/api/templates?teamId=${encodeURIComponent(teamId)}`);

        if (opts.format === 'json') {
          console.log(formatOutput(data, 'json'));
          return;
        }

        if (!data.length) {
          console.log('(no templates)');
          return;
        }

        console.log(formatTable(data, [
          { key: 'name', label: 'Name', width: 30 },
          { key: 'description', label: 'Description', width: 40 },
          { key: 'stage', label: 'Stage', width: 15 },
          { key: 'createdAt', label: 'Created', transform: (v) => timeAgo(String(v)) },
        ]));
        console.log(`\n${data.length} template(s)`);
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  templates
    .command('get <id>')
    .description('Get details of a specific template')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (id: string, opts: { format: OutputFormat }) => {
      const client = new NyxClient();

      try {
        const data = await client.get<Template>(`/api/templates/${id}`);
        console.log(formatOutput(data, opts.format));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  templates
    .command('create')
    .description('Create a new template')
    .requiredOption('--name <name>', 'Template name')
    .requiredOption('--description <description>', 'Template description')
    .requiredOption('--content <content>', 'Template content (markdown)')
    .requiredOption('--stage <stage>', 'Document stage (e.g. draft, review, approved)')
    .option('--team-id <teamId>', 'Team ID')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (opts: {
      name: string;
      description: string;
      content: string;
      stage: string;
      teamId?: string;
      format: OutputFormat;
    }) => {
      const teamId = resolveTeamId(opts.teamId);
      const client = new NyxClient();

      try {
        const data = await client.post<Template>('/api/templates', {
          name: opts.name,
          description: opts.description,
          content: opts.content,
          stage: opts.stage,
          teamId,
        });

        console.log(formatOutput(data, opts.format));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });
}

