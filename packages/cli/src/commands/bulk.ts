import { Command } from 'commander';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { NyxClient, resolveTeamId } from '../client.js';
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
    .option('--team-id <teamId>', 'Team ID')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .option('--export-format <exportFormat>', 'Export file format (markdown|pdf|txt|docx|latex|jupyter)', 'markdown')
    .option('--theme <theme>', 'LaTeX theme (only used with latex format)', 'default')
    .option('--stage <stage>', 'Filter by lifecycle stage')
    .option('--output-dir <dir>', 'Output directory', '.')
    .action(async (opts: {
      teamId?: string;
      format: OutputFormat;
      exportFormat: string;
      stage?: string;
      outputDir: string;
      theme: string;
    }) => {
      const validFormats = ['markdown', 'pdf', 'txt', 'docx', 'latex', 'jupyter'];
      if (!validFormats.includes(opts.exportFormat)) {
        error(
          `Invalid export format "${opts.exportFormat}". Must be one of: ${validFormats.join(', ')}`,
        );
      }

      const extMap: Record<string, string> = {
        markdown: 'md',
        pdf: 'pdf',
        txt: 'txt',
        docx: 'docx',
        latex: 'tex',
        jupyter: 'ipynb',
      };
      const binaryFormats = ['pdf', 'docx'];
      const postFormats = ['latex', 'jupyter'];

      const teamId = resolveTeamId(opts.teamId);
      const client = new NyxClient();
      try {
        const params = new URLSearchParams({ teamId });
        if (opts.stage) params.set('stage', opts.stage);

        const docs = await client.get<Document[]>(`/api/documents?${params}`);

        if (!Array.isArray(docs) || docs.length === 0) {
          process.stderr.write('No documents found.\n');
          console.log(formatOutput([], opts.format));
          return;
        }

        mkdirSync(opts.outputDir, { recursive: true });

        const ext = extMap[opts.exportFormat] ?? opts.exportFormat;
        const results: Array<{ id: string; title: string; file: string }> = [];

        for (const doc of docs) {
          const filename = `${sanitizeFilename(doc.title)}.${ext}`;
          const filePath = join(opts.outputDir, filename);
          process.stderr.write(`Exporting ${doc.title}...\n`);

          let res: Response;
          if (postFormats.includes(opts.exportFormat)) {
            const body = opts.exportFormat === 'latex' ? { theme: opts.theme } : {};
            res = await client.postRaw(
              `/api/export/documents/${doc.id}/export/${opts.exportFormat}`,
              body,
            );
          } else {
            res = await client.getRaw(
              `/api/export/documents/${doc.id}/export/${opts.exportFormat}`,
            );
          }

          if (binaryFormats.includes(opts.exportFormat)) {
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

  // `nyx bulk status` was removed when the draft/published/archived enum
  // was retired. Documents are now either live (deletedAt IS NULL) or
  // soft-deleted (deletedAt IS NOT NULL) — there is no per-doc status to
  // bulk-update.

  bulk
    .command('sync')
    .description('Sync all ticket statuses for a team')
    .option('--team-id <teamId>', 'Team ID')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (opts: { teamId?: string; format: OutputFormat }) => {
      const teamId = resolveTeamId(opts.teamId);
      const client = new NyxClient();
      try {
        const params = new URLSearchParams({ teamId });
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
