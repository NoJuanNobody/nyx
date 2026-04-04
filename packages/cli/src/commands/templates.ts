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

interface MarketplaceListing {
  id: string;
  name: string;
  description: string;
  author: string;
  downloads?: number;
  stage: string;
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

export function registerMarketplaceCommand(program: Command): void {
  const marketplace = program.command('marketplace').description('Browse and use the template marketplace');

  marketplace
    .command('list')
    .description('List available marketplace templates')
    .option('--format <format>', 'Output format (json|table)', 'table')
    .action(async (opts: { format: OutputFormat }) => {
      const client = new NyxClient();

      try {
        const data = await client.get<MarketplaceListing[]>('/api/marketplace');

        if (opts.format === 'json') {
          console.log(formatOutput(data, 'json'));
          return;
        }

        if (!data.length) {
          console.log('(no marketplace listings)');
          return;
        }

        console.log(formatTable(data, [
          { key: 'name', label: 'Name', width: 30 },
          { key: 'description', label: 'Description', width: 40 },
          { key: 'author', label: 'Author', width: 20 },
          { key: 'stage', label: 'Stage', width: 15 },
        ]));
        console.log(`\n${data.length} listing(s)`);
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  marketplace
    .command('get <id>')
    .description('Get details of a marketplace listing')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (id: string, opts: { format: OutputFormat }) => {
      const client = new NyxClient();

      try {
        const data = await client.get<MarketplaceListing>(`/api/marketplace/${id}`);
        console.log(formatOutput(data, opts.format));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  marketplace
    .command('use <listing-id>')
    .description('Create a document from a marketplace template')
    .option('--team-id <teamId>', 'Team ID')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (listingId: string, opts: { teamId?: string; format: OutputFormat }) => {
      const teamId = resolveTeamId(opts.teamId);
      const client = new NyxClient();

      try {
        const data = await client.post<Record<string, unknown>>('/api/documents/from-template', {
          listingId,
          teamId,
        });

        console.log(formatOutput(data, opts.format));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });
}
