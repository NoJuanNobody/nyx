import { Command } from 'commander';
import { writeFileSync } from 'node:fs';
import { NyxClient } from '../client.js';
import { formatOutput, formatTable, timeAgo, error, type OutputFormat } from '../utils/output.js';

export function registerDeliverablesCommand(program: Command): void {
  const deliverables = program
    .command('deliverables')
    .description('Generate and manage document deliverables');

  deliverables
    .command('generate <doc-id>')
    .description('Generate a deliverable for a document')
    .requiredOption('--type <type>', 'Deliverable type (pdf|markdown|report)')
    .requiredOption('--stage <stage>', 'Lifecycle stage')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (docId: string, opts: {
      type: string;
      stage: string;
      format: OutputFormat;
    }) => {
      const validTypes = ['pdf', 'markdown', 'report'];
      if (!validTypes.includes(opts.type)) {
        error(`Invalid type "${opts.type}". Must be one of: ${validTypes.join(', ')}`);
      }

      const client = new NyxClient();
      try {
        const data = await client.post<Record<string, unknown>>(
          `/api/documents/${docId}/deliverables`,
          { type: opts.type, stage: opts.stage },
        );
        console.log(formatOutput(data, opts.format));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  deliverables
    .command('list <doc-id>')
    .description('List deliverables for a document')
    .option('--format <format>', 'Output format (json|table)', 'table')
    .action(async (docId: string, opts: { format: OutputFormat }) => {
      const client = new NyxClient();
      try {
        const data = await client.get<{ deliverables: Record<string, unknown>[] }>(
          `/api/documents/${docId}/deliverables`,
        );
        const items = data.deliverables ?? [];
        if (opts.format === 'json') {
          console.log(formatOutput(items, 'json'));
        } else {
          console.log(formatTable(items, [
            { key: 'type', label: 'Type', width: 12 },
            { key: 'stage', label: 'Stage', width: 20 },
            { key: 'status', label: 'Status', width: 12 },
            { key: 'createdAt', label: 'Created', transform: (v) => timeAgo(String(v)) },
            { key: 'id', label: 'ID', width: 36 },
          ]));
          console.log(`\n${items.length} deliverable(s)`);
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  deliverables
    .command('export <doc-id>')
    .description('Export a document to a file')
    .requiredOption('--format <format>', 'Export format (markdown|pdf|txt|docx)')
    .option('--output <filename>', 'Output filename (default: <doc-title>.<format>)')
    .action(async (docId: string, opts: {
      format: string;
      output?: string;
    }) => {
      const validFormats = ['markdown', 'pdf', 'txt', 'docx'];
      if (!validFormats.includes(opts.format)) {
        error(`Invalid format "${opts.format}". Must be one of: ${validFormats.join(', ')}`);
      }

      const client = new NyxClient();
      try {
        const res = await client.getRaw(
          `/api/export/documents/${docId}/export/${opts.format}`,
        );

        // Extract filename from Content-Disposition header or use provided output name
        let filename = opts.output;
        if (!filename) {
          const disposition = res.headers.get('content-disposition');
          const match = disposition?.match(/filename="(.+?)"/);
          if (match) {
            filename = match[1];
          } else {
            const ext = opts.format === 'markdown' ? 'md' : opts.format;
            filename = `${docId}.${ext}`;
          }
        }

        if (opts.format === 'pdf' || opts.format === 'docx') {
          const buffer = Buffer.from(await res.arrayBuffer());
          writeFileSync(filename, buffer);
        } else {
          const text = await res.text();
          writeFileSync(filename, text, 'utf-8');
        }

        process.stderr.write(`Exported to ${filename}\n`);
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });
}
