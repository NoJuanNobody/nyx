import { Command } from 'commander';
import { NyxClient } from '../client.js';
import { formatOutput, formatTable, timeAgo, error, type OutputFormat } from '../utils/output.js';

export function registerBranchesCommand(program: Command): void {
  const branches = program.command('branches').description('Manage document branches');

  branches
    .command('list <doc-id>')
    .description('List branches for a document')
    .option('--format <format>', 'Output format (json|table)', 'table')
    .action(async (docId: string, opts: { format: OutputFormat }) => {
      const client = new NyxClient();
      try {
        const data = await client.get<Record<string, unknown>[]>(
          `/api/documents/${docId}/branches`,
        );
        if (opts.format === 'json') {
          console.log(formatOutput(data, 'json'));
        } else {
          console.log(
            formatTable(data, [
              { key: 'name', label: 'Name', width: 30 },
              { key: 'status', label: 'Status', width: 12 },
              {
                key: 'createdAt',
                label: 'Created',
                transform: (v) => timeAgo(String(v)),
              },
              {
                key: 'updatedAt',
                label: 'Updated',
                transform: (v) => timeAgo(String(v)),
              },
              { key: 'id', label: 'ID', width: 36 },
            ]),
          );
          console.log(`\n${data.length} branch(es)`);
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  branches
    .command('create <doc-id>')
    .description('Create a new branch for a document')
    .requiredOption('--name <name>', 'Branch name')
    .requiredOption('--base-version <versionId>', 'Base version ID to branch from')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(
      async (
        docId: string,
        opts: { name: string; baseVersion: string; format: OutputFormat },
      ) => {
        const client = new NyxClient();
        try {
          const data = await client.post(`/api/documents/${docId}/branches`, {
            name: opts.name,
            baseVersionId: opts.baseVersion,
          });
          console.log(formatOutput(data, opts.format));
        } catch (err) {
          error(err instanceof Error ? err.message : String(err));
        }
      },
    );

  branches
    .command('diff <branch-id>')
    .description('Show diff of a branch against its base version')
    .requiredOption('--doc-id <docId>', 'Document ID the branch belongs to')
    .option('--format <format>', 'Output format (json|readable)', 'readable')
    .action(
      async (
        branchId: string,
        opts: { docId: string; format: string },
      ) => {
        const client = new NyxClient();
        try {
          const data = await client.get<Record<string, unknown>>(
            `/api/documents/${opts.docId}/branches/${branchId}/diff`,
          );
          if (opts.format === 'json') {
            console.log(formatOutput(data, 'json'));
          } else {
            const lines: string[] = [];
            lines.push(`  Branch:   ${data.branchName ?? branchId}`);
            lines.push(`  Status:   ${data.status ?? ''}`);
            lines.push('');
            if (data.diff) {
              lines.push(String(data.diff));
            } else if (data.additions || data.deletions) {
              if (data.additions) {
                const additions = Array.isArray(data.additions)
                  ? data.additions
                  : [data.additions];
                for (const line of additions) {
                  lines.push(`+ ${line}`);
                }
              }
              if (data.deletions) {
                const deletions = Array.isArray(data.deletions)
                  ? data.deletions
                  : [data.deletions];
                for (const line of deletions) {
                  lines.push(`- ${line}`);
                }
              }
            } else {
              lines.push(JSON.stringify(data, null, 2));
            }
            console.log(lines.join('\n'));
          }
        } catch (err) {
          error(err instanceof Error ? err.message : String(err));
        }
      },
    );

  branches
    .command('approve <branch-id>')
    .description('Approve a branch for merging')
    .requiredOption('--doc-id <docId>', 'Document ID the branch belongs to')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(
      async (
        branchId: string,
        opts: { docId: string; format: OutputFormat },
      ) => {
        const client = new NyxClient();
        try {
          const data = await client.post(
            `/api/documents/${opts.docId}/branches/${branchId}/approve`,
          );
          console.log(formatOutput(data, opts.format));
        } catch (err) {
          error(err instanceof Error ? err.message : String(err));
        }
      },
    );

  branches
    .command('merge <branch-id>')
    .description('Merge a branch into the main document')
    .requiredOption('--doc-id <docId>', 'Document ID the branch belongs to')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(
      async (
        branchId: string,
        opts: { docId: string; format: OutputFormat },
      ) => {
        const client = new NyxClient();
        try {
          const data = await client.post(
            `/api/documents/${opts.docId}/branches/${branchId}/merge`,
          );
          console.log(formatOutput(data, opts.format));
        } catch (err) {
          error(err instanceof Error ? err.message : String(err));
        }
      },
    );
}
