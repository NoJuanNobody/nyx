import { Command } from 'commander';
import { NyxClient, resolveTeamId, resolveDocId } from '../client.js';
import { formatOutput, formatTable, timeAgo, error, type OutputFormat } from '../utils/output.js';

export function registerDocsCommand(program: Command): void {
  const docs = program.command('docs').description('Manage documents');

  docs
    .command('list')
    .description('List documents for a team')
    .option('--team-id <teamId>', 'Team ID')
    .option('--stage <stage>', 'Filter by stage')
    .option('--include-archived', 'Include archived documents')
    .option('--sort <sort>', 'Sort order (name|updated)')
    .option('--limit <n>', 'Limit results')
    .option('--format <format>', 'Output format (json|table)', 'table')
    .action(async (opts: {
      teamId?: string;
      stage?: string;
      includeArchived?: boolean;
      sort?: string;
      limit?: string;
      format: OutputFormat;
    }) => {
      const teamId = resolveTeamId(opts.teamId);
      const client = new NyxClient();
      const params = new URLSearchParams({ teamId });
      if (opts.stage) params.set('stage', opts.stage);
      if (opts.includeArchived) params.set('includeArchived', 'true');
      if (opts.sort) params.set('sort', opts.sort);
      if (opts.limit) params.set('limit', opts.limit);

      try {
        const data = await client.get<Record<string, unknown>[]>(`/api/documents?${params}`);
        if (opts.format === 'json') {
          console.log(formatOutput(data, 'json'));
        } else {
          console.log(formatTable(data, [
            { key: 'title', label: 'Title', width: 50 },
            { key: 'status', label: 'Status', width: 12 },
            { key: 'stage', label: 'Stage', width: 14 },
            { key: 'updatedAt', label: 'Updated', transform: (v) => timeAgo(String(v)) },
            { key: 'id', label: 'ID', width: 36 },
          ]));
          console.log(`\n${data.length} document(s)`);
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  docs
    .command('read <idOrTitle>')
    .description('Get a single document by ID or title search')
    .option('--team-id <teamId>', 'Team ID (required when searching by title)')
    .option('--format <format>', 'Output format (json|readable)', 'readable')
    .option('--meta-only', 'Show only metadata, no content')
    .action(async (idOrTitle: string, opts: { teamId?: string; format: string; metaOnly?: boolean }) => {
      const client = new NyxClient();
      try {
        const teamId = resolveTeamId(opts.teamId);
        const id = await resolveDocId(idOrTitle, client, teamId);
        const data = await client.get<Record<string, unknown>>(`/api/documents/${id}`);
        if (opts.format === 'json') {
          console.log(formatOutput(data, 'json'));
        } else {
          const lines: string[] = [];
          lines.push(`  Title:    ${data.title ?? ''}`);
          lines.push(`  Status:   ${data.status ?? ''}`);
          lines.push(`  Stage:    ${data.stage ?? ''}`);
          if (data.path) lines.push(`  Path:     ${data.path}`);
          lines.push(`  Created:  ${data.createdAt ? timeAgo(String(data.createdAt)) : ''}`);
          lines.push(`  Updated:  ${data.updatedAt ? timeAgo(String(data.updatedAt)) : ''}`);
          lines.push(`  ID:       ${data.id ?? ''}`);
          lines.push('');
          if (!opts.metaOnly && data.content) {
            lines.push(String(data.content));
          }
          console.log(lines.join('\n'));
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  docs
    .command('create')
    .description('Create a new document')
    .option('--team-id <teamId>', 'Team ID')
    .requiredOption('--title <title>', 'Document title')
    .option('--content <content>', 'Document content')
    .option('--stage <stage>', 'Lifecycle stage')
    .option('--path <path>', 'Document path')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (opts: {
      teamId?: string;
      title: string;
      content?: string;
      stage?: string;
      path?: string;
      format: OutputFormat;
    }) => {
      const teamId = resolveTeamId(opts.teamId);
      const client = new NyxClient();
      try {
        const data = await client.post('/api/documents', {
          teamId,
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
