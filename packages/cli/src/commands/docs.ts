import { Command } from 'commander';
import { NyxClient } from '../client.js';
import { formatOutput, error, type OutputFormat } from '../utils/output.js';

export function registerDocsCommand(program: Command): void {
  const docs = program.command('docs').description('Manage documents');

  docs
    .command('list')
    .description('List documents for a team')
    .requiredOption('--team-id <teamId>', 'Team ID')
    .option('--stage <stage>', 'Filter by stage')
    .option('--include-archived', 'Include archived documents')
    .option('--sort <sort>', 'Sort order (name|updated)')
    .option('--limit <n>', 'Limit results')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (opts: {
      teamId: string;
      stage?: string;
      includeArchived?: boolean;
      sort?: string;
      limit?: string;
      format: OutputFormat;
    }) => {
      const client = new NyxClient();
      const params = new URLSearchParams({ teamId: opts.teamId });
      if (opts.stage) params.set('stage', opts.stage);
      if (opts.includeArchived) params.set('includeArchived', 'true');
      if (opts.sort) params.set('sort', opts.sort);
      if (opts.limit) params.set('limit', opts.limit);

      try {
        const data = await client.get(`/api/documents?${params}`);
        console.log(formatOutput(data, opts.format));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  docs
    .command('read <id>')
    .description('Get a single document')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (id: string, opts: { format: OutputFormat }) => {
      const client = new NyxClient();
      try {
        const data = await client.get(`/api/documents/${id}`);
        console.log(formatOutput(data, opts.format));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  docs
    .command('create')
    .description('Create a new document')
    .requiredOption('--team-id <teamId>', 'Team ID')
    .requiredOption('--title <title>', 'Document title')
    .option('--content <content>', 'Document content')
    .option('--stage <stage>', 'Lifecycle stage')
    .option('--path <path>', 'Document path')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (opts: {
      teamId: string;
      title: string;
      content?: string;
      stage?: string;
      path?: string;
      format: OutputFormat;
    }) => {
      const client = new NyxClient();
      try {
        const data = await client.post('/api/documents', {
          teamId: opts.teamId,
          title: opts.title,
          content: opts.content,
          stage: opts.stage,
          path: opts.path,
        });
        console.log(formatOutput(data, opts.format));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  docs
    .command('update <id>')
    .description('Update a document')
    .option('--title <title>', 'New title')
    .option('--content <content>', 'New content')
    .option('--status <status>', 'New status (draft|published|archived)')
    .option('--stage <stage>', 'New lifecycle stage')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (id: string, opts: {
      title?: string;
      content?: string;
      status?: string;
      stage?: string;
      format: OutputFormat;
    }) => {
      const client = new NyxClient();
      const body: Record<string, string> = {};
      if (opts.title) body.title = opts.title;
      if (opts.content) body.content = opts.content;
      if (opts.status) body.status = opts.status;
      if (opts.stage) body.stage = opts.stage;

      try {
        const data = await client.put(`/api/documents/${id}`, body);
        console.log(formatOutput(data, opts.format));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  docs
    .command('delete <id>')
    .description('Archive a document')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (id: string, opts: { format: OutputFormat }) => {
      const client = new NyxClient();
      try {
        const data = await client.delete(`/api/documents/${id}`);
        console.log(formatOutput(data, opts.format));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });
}
