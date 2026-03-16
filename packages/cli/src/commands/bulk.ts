import { Command } from 'commander';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { NyxClient } from '../client.js';
import { formatOutput, error, type OutputFormat } from '../utils/output.js';

interface Document {
  id: string;
  title: string;
  stage?: string;
  status?: string;
  [key: string]: unknown;
}

function sanitizeFilename(title: string): string {
  return title.replace(/[^a-zA-Z0-9_\- ]/g, '').replace(/\s+/g, '_');
}

export function registerBulkCommand(program: Command): void {
  const bulk = program.command('bulk').description('Bulk document operations');

  bulk
    .command('export')
    .description('Export all documents for a team')
    .requiredOption('--team-id <teamId>', 'Team ID')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .option('--export-format <exportFormat>', 'Export file format (markdown|pdf)', 'markdown')
    .option('--stage <stage>', 'Filter by lifecycle stage')
    .option('--output-dir <dir>', 'Output directory', '.')
    .action(async (opts: {
      teamId: string;
      format: OutputFormat;
      exportFormat: string;
      stage?: string;
      outputDir: string;
    }) => {
      const client = new NyxClient();
      try {
        const params = new URLSearchParams({ teamId: opts.teamId });
        if (opts.stage) params.set('stage', opts.stage);

        const docs = await client.get<Document[]>(`/api/documents?${params}`);

        if (!Array.isArray(docs) || docs.length === 0) {
          process.stderr.write('No documents found.\n');
          console.log(formatOutput([], opts.format));
          return;
        }

        mkdirSync(opts.outputDir, { recursive: true });

        const ext = opts.exportFormat === 'pdf' ? 'pdf' : 'md';
        const exportType = opts.exportFormat === 'pdf' ? 'pdf' : 'markdown';
        const results: Array<{ id: string; title: string; file: string }> = [];

        for (const doc of docs) {
          const filename = `${sanitizeFilename(doc.title)}.${ext}`;
          const filePath = join(opts.outputDir, filename);
          process.stderr.write(`Exporting ${doc.title}...\n`);

          const res = await client.getRaw(
            `/api/export/documents/${doc.id}/export/${exportType}`,
          );

          if (ext === 'pdf') {
            const buffer = Buffer.from(await res.arrayBuffer());
            writeFileSync(filePath, buffer);
          } else {
            const text = await res.text();
            writeFileSync(filePath, text, 'utf-8');
          }

          results.push({ id: doc.id, title: doc.title, file: filename });
        }

        process.stderr.write(`Exported ${results.length} document(s).\n`);
        console.log(formatOutput(results, opts.format));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  bulk
    .command('status')
    .description('Bulk update document status')
    .requiredOption('--team-id <teamId>', 'Team ID')
    .requiredOption('--status <status>', 'New status (draft|published|archived)')
    .option('--stage <stage>', 'Filter by lifecycle stage')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (opts: {
      teamId: string;
      status: string;
      stage?: string;
      format: OutputFormat;
    }) => {
      const client = new NyxClient();
      try {
        const params = new URLSearchParams({ teamId: opts.teamId });
        if (opts.stage) params.set('stage', opts.stage);

        const docs = await client.get<Document[]>(`/api/documents?${params}`);

        if (!Array.isArray(docs) || docs.length === 0) {
          process.stderr.write('No documents found.\n');
          console.log(formatOutput({ updated: 0 }, opts.format));
          return;
        }

        let updated = 0;
        for (const doc of docs) {
          await client.put(`/api/documents/${doc.id}`, { status: opts.status });
          updated++;
        }

        process.stderr.write(`Updated ${updated} document(s) to status "${opts.status}".\n`);
        console.log(formatOutput({ updated, status: opts.status }, opts.format));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  bulk
    .command('sync')
    .description('Sync all ticket statuses for a team')
    .requiredOption('--team-id <teamId>', 'Team ID')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (opts: { teamId: string; format: OutputFormat }) => {
      const client = new NyxClient();
      try {
        const params = new URLSearchParams({ teamId: opts.teamId });
        const result = await client.post<unknown>(
          `/api/tickets/sync-all?${params}`,
        );
        process.stderr.write('Ticket sync complete.\n');
        console.log(formatOutput(result, opts.format));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });
}
